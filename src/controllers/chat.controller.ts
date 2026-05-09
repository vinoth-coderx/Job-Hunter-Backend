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

export const listConversations = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const items = await Conversation.find({
    participants: req.user._id,
    isArchived: false,
  })
    .sort({ updatedAt: -1 })
    .populate({
      path: 'participants',
      select: 'email profile.fullName profile.avatar',
    })
    .lean();

  res.json({
    success: true,
    data: items.map((c) => ({
      id: c._id.toString(),
      participants: c.participants,
      application: c.application,
      job: c.job,
      lastMessage: c.lastMessage,
      unreadCount: (c.unreadCount as unknown as Record<string, number>)?.[req.user!.id] ?? 0,
      updatedAt: c.updatedAt,
    })),
  });
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

  const existing = await Conversation.findOne(existingFilter).populate({
    path: 'participants',
    select: 'email profile.fullName profile.avatar',
  });
  if (existing) {
    res.json({
      success: true,
      data: {
        ...existing.toObject(),
        unreadCount:
          (existing.unreadCount as unknown as Record<string, number>)?.[
            req.user.id
          ] ?? 0,
      },
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

  // Populate participants so the client can render the peer's name and
  // avatar immediately without a follow-up fetch.
  const conv = await Conversation.findById(created._id).populate({
    path: 'participants',
    select: 'email profile.fullName profile.avatar',
  });

  res.status(201).json({
    success: true,
    data: {
      ...(conv ?? created).toObject(),
      unreadCount: 0,
    },
  });
});

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
