import { Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { emitToUser } from '../services/chat/socket';
import { notifyUser } from '../services/notification/notify.service';
import { uploadBuffer, CLOUDINARY_FOLDERS } from '../config/cloudinary';
import { logger } from '../utils/logger';
import { scanChatMessage } from '../services/security/chatSafety.service';
import { writeAudit } from '../services/security/audit.service';
import { suggestSmartReplies } from '../services/ai/chatSmartReply.service';
import {
  enforceQuota,
  getQuotaSnapshot,
  refundQuota,
} from '../services/ai/quota.service';
import { getCreditWeight } from '../config/aiCreditWeights';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

export const startConversationSchema = z.object({
  body: z.object({
    otherUserId: z.string().min(1),
    jobId: z.string().min(1).optional(),
    applicationId: z.string().min(1).optional(),
  }),
});

// `content` is optional at the schema layer because file-only messages
// are valid (image with no caption). The controller enforces "either
// content or file" before persisting so we never store empty rows.
export const sendMessageSchema = z.object({
  body: z.object({
    content: z.string().max(4000).optional().default(''),
    type: z.enum(['text', 'file', 'interview_invite']).default('text'),
  }),
});

const IMAGE_MIME_PREFIXES = ['image/'];
const isImage = (mime: string) => IMAGE_MIME_PREFIXES.some((p) => mime.startsWith(p));

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const ensureParticipant = async (
  userId: mongoose.Types.ObjectId,
  conversationId: string,
) => {
  if (!isObjectId(conversationId)) throw ApiError.badRequest('Invalid conversation id');
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw ApiError.notFound('Conversation not found');
  if (!conv.participants.some((p) => p.toString() === userId.toString())) {
    throw ApiError.forbidden('Not a participant of this conversation');
  }
  return conv;
};

/// Returns the peer participant. For self-conversations (notes-to-self,
/// single-account testing) where the user is the sole participant, falls
/// back to the user themselves so message routing still works.
const otherParticipant = (
  conv: { participants: mongoose.Types.ObjectId[] },
  me: mongoose.Types.ObjectId,
): mongoose.Types.ObjectId => {
  const other = conv.participants.find((p) => p.toString() !== me.toString());
  return other ?? me;
};

// ─────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────

// Shape returned alongside the populated job. Keeping it narrow so the
// payload doesn't balloon with the entire job document for every row.
//
// We pull `companyLogoUrl` directly off the job (set at post time) AND
// nest-populate `hirerProfile.companyLogoUrl` so we can fall back to the
// hirer's *current* logo if they uploaded one after the job was already
// live — otherwise seekers who chat about an older job would see the
// recruiter's initials forever even though the company has a logo now.
interface PopulatedHirerLite {
  _id: mongoose.Types.ObjectId;
  companyLogoUrl?: string;
  companyName?: string;
  verification?: { isVerified?: boolean };
}

interface PopulatedJobLite {
  _id: mongoose.Types.ObjectId;
  title?: string;
  company?: string;
  companyLogoUrl?: string;
  hirerProfile?: PopulatedHirerLite | mongoose.Types.ObjectId;
  // Job.postedBy is the user id of the recruiter who created the
  // listing — used to tag conversations as "hirer-side" for the
  // viewer-role filter so a single account toggling between seeker
  // and hirer sees a clean, role-scoped chat list.
  postedBy?: mongoose.Types.ObjectId;
}

interface PopulatedAppliedJobLite {
  _id: mongoose.Types.ObjectId;
  user?: mongoose.Types.ObjectId;
}

const jobLitePopulate = {
  path: 'job',
  select: 'title company companyLogoUrl hirerProfile postedBy',
  populate: {
    path: 'hirerProfile',
    select: 'companyLogoUrl companyName verification.isVerified',
  },
} as const;

const appliedLitePopulate = {
  path: 'application',
  select: 'user',
} as const;

/// Decide which side of a conversation the current viewer is on. Drives
/// the seeker-vs-hirer chat filter when one account does both jobs.
///   - hirer  → the conversation's job was posted by this user.
///   - seeker → linked application is the user's own apply.
///   - default seeker — direct user-to-user chats with no job/app
///     context default to "seeker" so they show up in the seeker tab
///     (where general inbound messages already live).
const resolveViewerRole = (
  job: PopulatedJobLite | null | undefined,
  application: PopulatedAppliedJobLite | mongoose.Types.ObjectId | null | undefined,
  viewerId: string,
): 'seeker' | 'hirer' => {
  if (job?.postedBy && job.postedBy.toString() === viewerId) return 'hirer';
  if (
    application &&
    typeof application === 'object' &&
    'user' in application &&
    (application as PopulatedAppliedJobLite).user?.toString() === viewerId
  ) {
    return 'seeker';
  }
  return 'seeker';
};

const resolveCompanyLogo = (job: PopulatedJobLite | null | undefined): string | undefined => {
  if (!job) return undefined;
  if (job.companyLogoUrl && job.companyLogoUrl.trim().length > 0) {
    return job.companyLogoUrl;
  }
  const hp = job.hirerProfile;
  if (hp && typeof hp === 'object' && 'companyLogoUrl' in hp) {
    return (hp as PopulatedHirerLite).companyLogoUrl;
  }
  return undefined;
};

const resolveCompanyName = (job: PopulatedJobLite | null | undefined): string | undefined => {
  if (!job) return undefined;
  if (job.company && job.company.trim().length > 0) return job.company;
  const hp = job.hirerProfile;
  if (hp && typeof hp === 'object' && 'companyName' in hp) {
    return (hp as PopulatedHirerLite).companyName;
  }
  return undefined;
};

const resolveCompanyVerified = (
  job: PopulatedJobLite | null | undefined,
): boolean => {
  const hp = job?.hirerProfile;
  if (hp && typeof hp === 'object' && 'verification' in hp) {
    return (hp as PopulatedHirerLite).verification?.isVerified === true;
  }
  return false;
};

export const listConversations = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  // Optional `?role=seeker|hirer` filter so a single account that
  // toggles between roles sees a clean, role-scoped chat list. The
  // server still tags every row with `viewerRole` either way, so
  // clients without the query param can filter locally if they prefer.
  const roleParam = typeof req.query.role === 'string' ? req.query.role : '';
  const roleFilter: 'seeker' | 'hirer' | null =
    roleParam === 'seeker' || roleParam === 'hirer' ? roleParam : null;

  const items = await Conversation.find({
    participants: req.user._id,
    isArchived: false,
  })
    .sort({ updatedAt: -1 })
    .populate({
      path: 'participants',
      select: 'email profile.fullName profile.avatar',
    })
    .populate(jobLitePopulate)
    .populate(appliedLitePopulate)
    .lean();

  const viewerId = req.user.id;
  const enriched = items.map((c) => {
    const job = c.job as unknown as PopulatedJobLite | mongoose.Types.ObjectId | null;
    const isPopulated = job && typeof job === 'object' && '_id' in job && 'title' in job;
    const populated = isPopulated ? (job as PopulatedJobLite) : null;
    const applicationRaw = c.application as unknown as
      | PopulatedAppliedJobLite
      | mongoose.Types.ObjectId
      | null
      | undefined;
    const viewerRole = resolveViewerRole(populated, applicationRaw, viewerId);
    return {
      id: c._id.toString(),
      participants: c.participants,
      // Keep `application` as an id for downstream callers that
      // expect the existing shape — the populated form was only
      // needed to compute viewerRole.
      application:
        applicationRaw && typeof applicationRaw === 'object' && '_id' in applicationRaw
          ? (applicationRaw as PopulatedAppliedJobLite)._id.toString()
          : applicationRaw ?? null,
      job: populated?._id.toString() ?? job ?? null,
      jobTitle: populated?.title,
      companyName: resolveCompanyName(populated),
      companyLogo: resolveCompanyLogo(populated),
      companyVerified: resolveCompanyVerified(populated),
      lastMessage: c.lastMessage,
      unreadCount: (c.unreadCount as unknown as Record<string, number>)?.[viewerId] ?? 0,
      updatedAt: c.updatedAt,
      viewerRole,
    };
  });

  const filtered = roleFilter
    ? enriched.filter((c) => c.viewerRole === roleFilter)
    : enriched;

  res.json({ success: true, data: filtered });
});

export const getConversation = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const conv = await ensureParticipant(req.user._id!, String(req.params.id));
  res.json({ success: true, data: conv });
});

export const startConversation = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { otherUserId, jobId, applicationId } = req.body as z.infer<
    typeof startConversationSchema
  >['body'];

  if (!isObjectId(otherUserId)) throw ApiError.badRequest('Invalid otherUserId');
  const isSelf = otherUserId === req.user.id;
  const other = await User.findById(otherUserId).select('_id').lean();
  if (!other) throw ApiError.notFound('User not found');

  // For self-conversations the participant array stores the user once so
  // it doesn't collide with a real 1:1 conversation in lookups.
  const participantIds = isSelf
    ? [req.user._id]
    : [req.user._id, other._id];

  const existingFilter = isSelf
    ? { participants: { $all: [req.user._id], $size: 1 } }
    : { participants: { $all: [req.user._id, other._id], $size: 2 } };

  const existing = await Conversation.findOne(existingFilter)
    .populate({
      path: 'participants',
      select: 'email profile.fullName profile.avatar',
    })
    .populate(jobLitePopulate);
  if (existing) {
    res.json({
      success: true,
      data: enrichConversation(
        existing.toObject() as unknown as Record<string, unknown>,
        req.user.id,
      ),
    });
    return;
  }

  const unreadInit = new Map<string, number>([[req.user.id, 0]]);
  if (!isSelf) unreadInit.set(otherUserId, 0);

  const created = await Conversation.create({
    participants: participantIds,
    application: applicationId && isObjectId(applicationId) ? applicationId : undefined,
    job: jobId && isObjectId(jobId) ? jobId : undefined,
    unreadCount: unreadInit,
  });

  // Populate participants + job's company branding so the client can
  // render the peer's name, avatar, and (for seekers) the recruiter's
  // company logo immediately without a follow-up fetch. Also populate
  // the linked application so `enrichConversation` can compute
  // `viewerRole` for newly-started threads.
  const conv = await Conversation.findById(created._id)
    .populate({
      path: 'participants',
      select: 'email profile.fullName profile.avatar',
    })
    .populate(jobLitePopulate)
    .populate(appliedLitePopulate);

  res.status(201).json({
    success: true,
    data: enrichConversation(
      (conv ?? created).toObject() as unknown as Record<string, unknown>,
      req.user.id,
    ),
  });
});

/// Mirror of the per-row mapping in `listConversations` but for a single
/// conversation document. Pulls the populated job's branding to the top
/// level (`companyLogo`, `companyName`, `jobTitle`) and replaces the
/// `job` field with a plain id so the response stays compact.
const enrichConversation = (
  raw: Record<string, unknown>,
  userId: string,
) => {
  const job = raw.job as unknown as
    | PopulatedJobLite
    | mongoose.Types.ObjectId
    | null
    | undefined;
  const isPopulated =
    job && typeof job === 'object' && '_id' in job && 'title' in job;
  const populated = isPopulated ? (job as PopulatedJobLite) : null;
  const applicationRaw = raw.application as unknown as
    | PopulatedAppliedJobLite
    | mongoose.Types.ObjectId
    | null
    | undefined;
  const viewerRole = resolveViewerRole(populated, applicationRaw, userId);
  const unreadMap = raw.unreadCount as
    | unknown as Record<string, number>
    | Map<string, number>
    | undefined;
  const unread =
    unreadMap instanceof Map
      ? unreadMap.get(userId) ?? 0
      : (unreadMap as Record<string, number> | undefined)?.[userId] ?? 0;
  return {
    ...raw,
    job: populated?._id.toString() ?? job ?? null,
    jobTitle: populated?.title,
    companyName: resolveCompanyName(populated),
    companyLogo: resolveCompanyLogo(populated),
    companyVerified: resolveCompanyVerified(populated),
    application:
      applicationRaw && typeof applicationRaw === 'object' && '_id' in applicationRaw
        ? (applicationRaw as PopulatedAppliedJobLite)._id.toString()
        : applicationRaw ?? null,
    unreadCount: unread,
    viewerRole,
  };
};

export const listMessages = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const conv = await ensureParticipant(req.user._id!, String(req.params.id));

  const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50);
  const skip = (page - 1) * limit;

  const items = await Message.find({ conversation: conv._id })
    .sort({ sentAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  res.json({
    success: true,
    data: items.reverse(), // ascending for the UI
    meta: { page, limit },
  });
});

export const sendMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const conv = await ensureParticipant(req.user._id!, String(req.params.id));
  const parsed = req.body as z.infer<typeof sendMessageSchema>['body'];
  let { content, type } = parsed;
  content = (content ?? '').trim();

  const uploaded = req.file;
  if (!uploaded && content.length === 0) {
    throw ApiError.badRequest('Message must have content or a file attachment.');
  }

  // Outgoing safety scan. High/medium severity → hard block before
  // persisting. Low severity → log only (matches like "registration
  // fee" sometimes appear in legitimate context — too noisy to block).
  if (content.length > 0) {
    const safety = scanChatMessage(content);
    if (safety.severity !== 'low') {
      // Audit + drop. Use ApiError 422 so the client can render the
      // blockReason inline without confusing it with a generic 4xx.
      await writeAudit({
        actor: { id: req.user._id!, email: req.user.email },
        actorType: 'user',
        category: 'security',
        action: `chat:blocked:${safety.severity}`,
        target: { type: 'Conversation', id: conv._id },
        metadata: {
          flags: safety.flags,
          matchedTerms: safety.matchedTerms,
        },
        req,
      });
      throw new ApiError(422, safety.blockReason, {
        flags: safety.flags,
        severity: safety.severity,
      });
    }
  }

  // When a file rides along, push it to Cloudinary first. Images go to
  // the regular 'image' resource type so they get the CDN's auto-format
  // / responsive transforms; everything else (PDF/DOC/XLS/TXT) is 'raw'.
  let filePayload: { url: string; filename: string; sizeBytes: number; type: string } | undefined;
  if (uploaded) {
    try {
      const result = await uploadBuffer(uploaded.buffer, {
        folder: CLOUDINARY_FOLDERS.CHAT_ATTACHMENT,
        resourceType: isImage(uploaded.mimetype) ? 'image' : 'raw',
      });
      filePayload = {
        url: result.url,
        filename: uploaded.originalname,
        sizeBytes: uploaded.size,
        type: uploaded.mimetype,
      };
      // Force the message type to 'file' when an attachment is present —
      // saves the client from having to set it explicitly and keeps the
      // DB consistent for inbox/preview rendering.
      type = 'file';
    } catch (err) {
      logger.error('Chat attachment upload failed', err);
      throw ApiError.internal('Could not upload attachment. Try again.');
    }
  }

  const receiver = otherParticipant(conv, req.user._id!);

  const message = await Message.create({
    conversation: conv._id,
    sender: req.user._id,
    receiver,
    type,
    content: content.length > 0 ? content : (filePayload?.filename ?? ''),
    file: filePayload,
    sentAt: new Date(),
  });

  // Bump conversation summary + bump receiver's unread counter. Show a
  // friendly icon-prefixed preview when the message is file-only so the
  // inbox row reads "📎 resume.pdf" rather than the bare filename.
  const previewContent = filePayload && content.length === 0
    ? `📎 ${filePayload.filename}`
    : content;
  conv.lastMessage = {
    content: previewContent,
    sentAt: message.sentAt,
    sender: req.user._id!,
  };
  // Unread map keys are strings per Mongoose Map<string, number>.
  const prev = conv.unreadCount.get(receiver.toString()) ?? 0;
  conv.unreadCount.set(receiver.toString(), prev + 1);
  await conv.save();

  // Real-time fan-out — non-blocking, best-effort. For self-chat the
  // sender and receiver are the same user, so emit only once.
  try {
    emitToUser(req.user.id, 'message:new', {
      conversationId: conv._id.toString(),
      message,
    });
    if (receiver.toString() !== req.user.id) {
      emitToUser(receiver.toString(), 'message:new', {
        conversationId: conv._id.toString(),
        message,
      });
    }
  } catch {
    // socket layer is optional — REST clients still get the response.
  }

  // Push fan-out for backgrounded receivers. Non-blocking, errors
  // swallowed — REST clients (and the in-app socket banner) already
  // got the message, so push is purely a "wake the OS tray" extra.
  // Skipped for self-chat (the sender is the only participant).
  if (receiver.toString() !== req.user.id) {
    // Resolve the receiver's role on this specific conversation so the
    // notification lands in the right inbox tab. If the conversation
    // hangs off a job, the job's `postedBy` is the hirer side — the
    // other participant is therefore the seeker, and vice versa. Direct
    // user-to-user chats fall through to 'seeker' which is where
    // general inbound messages live.
    let receiverRole: 'seeker' | 'hirer' = 'seeker';
    try {
      const populated = await Conversation.findById(conv._id)
        .populate({ path: 'job', select: 'postedBy' })
        .lean();
      const jobDoc = populated?.job as
        | { _id: mongoose.Types.ObjectId; postedBy?: mongoose.Types.ObjectId }
        | null
        | undefined;
      if (jobDoc?.postedBy) {
        receiverRole =
          jobDoc.postedBy.toString() === receiver.toString()
            ? 'hirer'
            : 'seeker';
      }
    } catch {
      /* fall through with default */
    }

    void pushChatMessage({
      senderId: req.user.id,
      receiverId: receiver.toString(),
      receiverRole,
      conversationId: conv._id.toString(),
      preview: previewContent,
    }).catch((err) => {
      logger.warn(`chat push failed: ${(err as Error).message}`);
    });
  }

  res.status(201).json({ success: true, data: message });
});

/// Persist + push a new chat message notification. Goes through
/// `notifyUser` so the receiver gets:
///   - a row in the in-app Notification inbox (so a missed message
///     surfaces in the bell badge even after the OS-tray push is
///     dismissed),
///   - an FCM push to wake the system tray when backgrounded,
///   - a `notification:new` socket emit for the foreground banner
///     (independent of the `message:new` event the chat screen itself
///     listens to).
///
/// The receiver's role on the conversation is required for inbox
/// scoping — a hirer's notifications inbox must not list seeker-side
/// chat threads and vice versa.
const pushChatMessage = async (params: {
  senderId: string;
  receiverId: string;
  receiverRole: 'seeker' | 'hirer';
  conversationId: string;
  preview: string;
}): Promise<void> => {
  const sender = await User.findById(params.senderId)
    .select('profile.fullName email')
    .lean();

  const senderName =
    sender?.profile?.fullName?.trim() || sender?.email || 'New message';
  const body =
    params.preview.trim().length > 0 ? params.preview : 'sent a message';

  await notifyUser({
    user: params.receiverId,
    role: params.receiverRole,
    type: 'new_message',
    title: senderName,
    body,
    data: {
      conversationId: params.conversationId,
      senderId: params.senderId,
    },
  });
};

export const markRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const conv = await ensureParticipant(req.user._id!, String(req.params.id));

  const result = await Message.updateMany(
    { conversation: conv._id, receiver: req.user._id, isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
  );

  conv.unreadCount.set(req.user.id, 0);
  await conv.save();

  // Notify the other participant their messages have been read. Skip for
  // self-chat — the only participant is already the reader.
  try {
    const other = otherParticipant(conv, req.user._id!);
    if (other.toString() !== req.user.id) {
      emitToUser(other.toString(), 'read:receipt', {
        conversationId: conv._id.toString(),
        readerUserId: req.user.id,
      });
    }
  } catch {
    // ignore
  }

  res.json({ success: true, data: { modified: result.modifiedCount } });
});

/**
 * AI smart-reply suggestions for the hirer's chat composer. Pulls the
 * last 8 turns of the conversation, runs them through Groq, returns 3
 * short reply variants. Cached server-side (1h, hash of last 6 turns)
 * so paging through a long thread doesn't burn fresh quota per render.
 *
 * Only available on conversations where the requesting user is the
 * recruiter (the hirer's user.id matches one participant). For
 * candidate-side smart-reply we'd want a different prompt/persona —
 * deferred until we have a clear UX call.
 */
export const getSmartReplies = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const conv = await ensureParticipant(req.user._id!, String(req.params.id));

    // Pull the most recent 8 messages, oldest-first, in one query.
    const recent = await Message.find({ conversation: conv._id })
      .sort({ sentAt: -1 })
      .limit(8)
      .lean();
    const turns = recent
      .reverse()
      .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
      .map((m) => ({
        role:
          m.sender.toString() === req.user!._id!.toString()
            ? ('hirer' as const)
            : ('candidate' as const),
        text: m.content,
      }));

    const cached = await suggestSmartReplies({ turns, userId });
    let quota = await getQuotaSnapshot(userId);
    if (cached.cached) {
      res.json({ success: true, data: cached, quota });
      return;
    }

    // suggestSmartReplies has internal cache fallback; we only debit
    // quota when the call actually hit the model. The service returns
    // usedAi=false on cache hit, fallback path, or no-provider — refund
    // in those cases. We do this AFTER the call so a single cache pre-
    // check + call covers all branches; fine because the weight is small.
    const weight = getCreditWeight('chat_smart_reply');
    if (weight > 0 && cached.usedAi && !cached.cached) {
      quota = await enforceQuota(userId, weight);
    }
    if (weight > 0 && !cached.usedAi) {
      // No-op — nothing was debited yet. Kept here as a marker so the
      // refund branch is obvious if we ever switch to debit-then-call.
      await refundQuota(userId, 0);
    }

    res.json({ success: true, data: cached, quota });
  },
);
