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

export const sendMessageSchema = z.object({
  body: z.object({
    content: z.string().min(1).max(4000),
    type: z.enum(['text', 'file', 'interview_invite']).default('text'),
  }),
});

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
    select: 'companyLogoUrl companyName',
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
  const { content, type } = req.body as z.infer<typeof sendMessageSchema>['body'];

  const receiver = otherParticipant(conv, req.user._id!);

  const message = await Message.create({
    conversation: conv._id,
    sender: req.user._id,
    receiver,
    type,
    content,
    sentAt: new Date(),
  });

  // Bump conversation summary + bump receiver's unread counter.
  conv.lastMessage = {
    content,
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

  res.status(201).json({ success: true, data: message });
});

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
