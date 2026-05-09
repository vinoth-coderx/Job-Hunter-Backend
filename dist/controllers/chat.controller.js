"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.markRead = exports.sendMessage = exports.listMessages = exports.startConversation = exports.getConversation = exports.listConversations = exports.sendMessageSchema = exports.startConversationSchema = void 0;
const zod_1 = require("zod");
const Conversation_1 = require("../models/Conversation");
const Message_1 = require("../models/Message");
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const socket_1 = require("../services/chat/socket");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
exports.startConversationSchema = zod_1.z.object({
    body: zod_1.z.object({
        otherUserId: zod_1.z.string().min(1),
        jobId: zod_1.z.string().min(1).optional(),
        applicationId: zod_1.z.string().min(1).optional(),
    }),
});
exports.sendMessageSchema = zod_1.z.object({
    body: zod_1.z.object({
        content: zod_1.z.string().min(1).max(4000),
        type: zod_1.z.enum(['text', 'file', 'interview_invite']).default('text'),
    }),
});
const ensureParticipant = async (userId, conversationId) => {
    if (!isObjectId(conversationId))
        throw ApiError_1.ApiError.badRequest('Invalid conversation id');
    const conv = await Conversation_1.Conversation.findById(conversationId);
    if (!conv)
        throw ApiError_1.ApiError.notFound('Conversation not found');
    if (!conv.participants.some((p) => p.toString() === userId.toString())) {
        throw ApiError_1.ApiError.forbidden('Not a participant of this conversation');
    }
    return conv;
};
const otherParticipant = (conv, me) => {
    const other = conv.participants.find((p) => p.toString() !== me.toString());
    return other ?? me;
};
exports.listConversations = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const items = await Conversation_1.Conversation.find({
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
            unreadCount: c.unreadCount?.[req.user.id] ?? 0,
            updatedAt: c.updatedAt,
        })),
    });
});
exports.getConversation = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const conv = await ensureParticipant(req.user._id, String(req.params.id));
    res.json({ success: true, data: conv });
});
exports.startConversation = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { otherUserId, jobId, applicationId } = req.body;
    if (!isObjectId(otherUserId))
        throw ApiError_1.ApiError.badRequest('Invalid otherUserId');
    const isSelf = otherUserId === req.user.id;
    const other = await User_1.User.findById(otherUserId).select('_id').lean();
    if (!other)
        throw ApiError_1.ApiError.notFound('User not found');
    const participantIds = isSelf
        ? [req.user._id]
        : [req.user._id, other._id];
    const existingFilter = isSelf
        ? { participants: { $all: [req.user._id], $size: 1 } }
        : { participants: { $all: [req.user._id, other._id], $size: 2 } };
    const existing = await Conversation_1.Conversation.findOne(existingFilter).populate({
        path: 'participants',
        select: 'email profile.fullName profile.avatar',
    });
    if (existing) {
        res.json({
            success: true,
            data: {
                ...existing.toObject(),
                unreadCount: existing.unreadCount?.[req.user.id] ?? 0,
            },
        });
        return;
    }
    const unreadInit = new Map([[req.user.id, 0]]);
    if (!isSelf)
        unreadInit.set(otherUserId, 0);
    const created = await Conversation_1.Conversation.create({
        participants: participantIds,
        application: applicationId && isObjectId(applicationId) ? applicationId : undefined,
        job: jobId && isObjectId(jobId) ? jobId : undefined,
        unreadCount: unreadInit,
    });
    const conv = await Conversation_1.Conversation.findById(created._id).populate({
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
exports.listMessages = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const conv = await ensureParticipant(req.user._id, String(req.params.id));
    const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50);
    const skip = (page - 1) * limit;
    const items = await Message_1.Message.find({ conversation: conv._id })
        .sort({ sentAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
    res.json({
        success: true,
        data: items.reverse(),
        meta: { page, limit },
    });
});
exports.sendMessage = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const conv = await ensureParticipant(req.user._id, String(req.params.id));
    const { content, type } = req.body;
    const receiver = otherParticipant(conv, req.user._id);
    const message = await Message_1.Message.create({
        conversation: conv._id,
        sender: req.user._id,
        receiver,
        type,
        content,
        sentAt: new Date(),
    });
    conv.lastMessage = {
        content,
        sentAt: message.sentAt,
        sender: req.user._id,
    };
    const prev = conv.unreadCount.get(receiver.toString()) ?? 0;
    conv.unreadCount.set(receiver.toString(), prev + 1);
    await conv.save();
    try {
        (0, socket_1.emitToUser)(req.user.id, 'message:new', {
            conversationId: conv._id.toString(),
            message,
        });
        if (receiver.toString() !== req.user.id) {
            (0, socket_1.emitToUser)(receiver.toString(), 'message:new', {
                conversationId: conv._id.toString(),
                message,
            });
        }
    }
    catch {
    }
    res.status(201).json({ success: true, data: message });
});
exports.markRead = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const conv = await ensureParticipant(req.user._id, String(req.params.id));
    const result = await Message_1.Message.updateMany({ conversation: conv._id, receiver: req.user._id, isRead: false }, { $set: { isRead: true, readAt: new Date() } });
    conv.unreadCount.set(req.user.id, 0);
    await conv.save();
    try {
        const other = otherParticipant(conv, req.user._id);
        if (other.toString() !== req.user.id) {
            (0, socket_1.emitToUser)(other.toString(), 'read:receipt', {
                conversationId: conv._id.toString(),
                readerUserId: req.user.id,
            });
        }
    }
    catch {
    }
    res.json({ success: true, data: { modified: result.modifiedCount } });
});
