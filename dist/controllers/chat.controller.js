"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSmartReplies = exports.markRead = exports.sendMessage = exports.listMessages = exports.startConversation = exports.getConversation = exports.listConversations = exports.sendMessageSchema = exports.startConversationSchema = void 0;
const zod_1 = require("zod");
const Conversation_1 = require("../models/Conversation");
const Message_1 = require("../models/Message");
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const socket_1 = require("../services/chat/socket");
const notify_service_1 = require("../services/notification/notify.service");
const cloudinary_1 = require("../config/cloudinary");
const logger_1 = require("../utils/logger");
const chatSafety_service_1 = require("../services/security/chatSafety.service");
const audit_service_1 = require("../services/security/audit.service");
const chatSmartReply_service_1 = require("../services/ai/chatSmartReply.service");
const quota_service_1 = require("../services/ai/quota.service");
const aiCreditWeights_1 = require("../config/aiCreditWeights");
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
        content: zod_1.z.string().max(4000).optional().default(''),
        type: zod_1.z.enum(['text', 'file', 'interview_invite']).default('text'),
    }),
});
const IMAGE_MIME_PREFIXES = ['image/'];
const isImage = (mime) => IMAGE_MIME_PREFIXES.some((p) => mime.startsWith(p));
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
const jobLitePopulate = {
    path: 'job',
    select: 'title company companyLogoUrl hirerProfile postedBy',
    populate: {
        path: 'hirerProfile',
        select: 'companyLogoUrl companyName verification.isVerified',
    },
};
const appliedLitePopulate = {
    path: 'application',
    select: 'user',
};
const resolveViewerRole = (job, application, viewerId) => {
    if (job?.postedBy && job.postedBy.toString() === viewerId)
        return 'hirer';
    if (application &&
        typeof application === 'object' &&
        'user' in application &&
        application.user?.toString() === viewerId) {
        return 'seeker';
    }
    return 'seeker';
};
const resolveCompanyLogo = (job) => {
    if (!job)
        return undefined;
    if (job.companyLogoUrl && job.companyLogoUrl.trim().length > 0) {
        return job.companyLogoUrl;
    }
    const hp = job.hirerProfile;
    if (hp && typeof hp === 'object' && 'companyLogoUrl' in hp) {
        return hp.companyLogoUrl;
    }
    return undefined;
};
const resolveCompanyName = (job) => {
    if (!job)
        return undefined;
    if (job.company && job.company.trim().length > 0)
        return job.company;
    const hp = job.hirerProfile;
    if (hp && typeof hp === 'object' && 'companyName' in hp) {
        return hp.companyName;
    }
    return undefined;
};
const resolveCompanyVerified = (job) => {
    const hp = job?.hirerProfile;
    if (hp && typeof hp === 'object' && 'verification' in hp) {
        return hp.verification?.isVerified === true;
    }
    return false;
};
exports.listConversations = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const roleParam = typeof req.query.role === 'string' ? req.query.role : '';
    const roleFilter = roleParam === 'seeker' || roleParam === 'hirer' ? roleParam : null;
    const items = await Conversation_1.Conversation.find({
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
        const job = c.job;
        const isPopulated = job && typeof job === 'object' && '_id' in job && 'title' in job;
        const populated = isPopulated ? job : null;
        const applicationRaw = c.application;
        const viewerRole = resolveViewerRole(populated, applicationRaw, viewerId);
        return {
            id: c._id.toString(),
            participants: c.participants,
            application: applicationRaw && typeof applicationRaw === 'object' && '_id' in applicationRaw
                ? applicationRaw._id.toString()
                : applicationRaw ?? null,
            job: populated?._id.toString() ?? job ?? null,
            jobTitle: populated?.title,
            companyName: resolveCompanyName(populated),
            companyLogo: resolveCompanyLogo(populated),
            companyVerified: resolveCompanyVerified(populated),
            lastMessage: c.lastMessage,
            unreadCount: c.unreadCount?.[viewerId] ?? 0,
            updatedAt: c.updatedAt,
            viewerRole,
        };
    });
    const filtered = roleFilter
        ? enriched.filter((c) => c.viewerRole === roleFilter)
        : enriched;
    res.json({ success: true, data: filtered });
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
    const existing = await Conversation_1.Conversation.findOne(existingFilter)
        .populate({
        path: 'participants',
        select: 'email profile.fullName profile.avatar',
    })
        .populate(jobLitePopulate);
    if (existing) {
        res.json({
            success: true,
            data: enrichConversation(existing.toObject(), req.user.id),
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
    const conv = await Conversation_1.Conversation.findById(created._id)
        .populate({
        path: 'participants',
        select: 'email profile.fullName profile.avatar',
    })
        .populate(jobLitePopulate)
        .populate(appliedLitePopulate);
    res.status(201).json({
        success: true,
        data: enrichConversation((conv ?? created).toObject(), req.user.id),
    });
});
const enrichConversation = (raw, userId) => {
    const job = raw.job;
    const isPopulated = job && typeof job === 'object' && '_id' in job && 'title' in job;
    const populated = isPopulated ? job : null;
    const applicationRaw = raw.application;
    const viewerRole = resolveViewerRole(populated, applicationRaw, userId);
    const unreadMap = raw.unreadCount;
    const unread = unreadMap instanceof Map
        ? unreadMap.get(userId) ?? 0
        : unreadMap?.[userId] ?? 0;
    return {
        ...raw,
        job: populated?._id.toString() ?? job ?? null,
        jobTitle: populated?.title,
        companyName: resolveCompanyName(populated),
        companyLogo: resolveCompanyLogo(populated),
        companyVerified: resolveCompanyVerified(populated),
        application: applicationRaw && typeof applicationRaw === 'object' && '_id' in applicationRaw
            ? applicationRaw._id.toString()
            : applicationRaw ?? null,
        unreadCount: unread,
        viewerRole,
    };
};
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
    const parsed = req.body;
    let { content, type } = parsed;
    content = (content ?? '').trim();
    const uploaded = req.file;
    if (!uploaded && content.length === 0) {
        throw ApiError_1.ApiError.badRequest('Message must have content or a file attachment.');
    }
    if (content.length > 0) {
        const safety = (0, chatSafety_service_1.scanChatMessage)(content);
        if (safety.severity !== 'low') {
            await (0, audit_service_1.writeAudit)({
                actor: { id: req.user._id, email: req.user.email },
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
            throw new ApiError_1.ApiError(422, safety.blockReason, {
                flags: safety.flags,
                severity: safety.severity,
            });
        }
    }
    let filePayload;
    if (uploaded) {
        try {
            const result = await (0, cloudinary_1.uploadBuffer)(uploaded.buffer, {
                folder: cloudinary_1.CLOUDINARY_FOLDERS.CHAT_ATTACHMENT,
                resourceType: isImage(uploaded.mimetype) ? 'image' : 'raw',
            });
            filePayload = {
                url: result.url,
                filename: uploaded.originalname,
                sizeBytes: uploaded.size,
                type: uploaded.mimetype,
            };
            type = 'file';
        }
        catch (err) {
            logger_1.logger.error('Chat attachment upload failed', err);
            throw ApiError_1.ApiError.internal('Could not upload attachment. Try again.');
        }
    }
    const receiver = otherParticipant(conv, req.user._id);
    const message = await Message_1.Message.create({
        conversation: conv._id,
        sender: req.user._id,
        receiver,
        type,
        content: content.length > 0 ? content : (filePayload?.filename ?? ''),
        file: filePayload,
        sentAt: new Date(),
    });
    const previewContent = filePayload && content.length === 0
        ? `📎 ${filePayload.filename}`
        : content;
    conv.lastMessage = {
        content: previewContent,
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
    if (receiver.toString() !== req.user.id) {
        let receiverRole = 'seeker';
        try {
            const populated = await Conversation_1.Conversation.findById(conv._id)
                .populate({ path: 'job', select: 'postedBy' })
                .lean();
            const jobDoc = populated?.job;
            if (jobDoc?.postedBy) {
                receiverRole =
                    jobDoc.postedBy.toString() === receiver.toString()
                        ? 'hirer'
                        : 'seeker';
            }
        }
        catch {
        }
        void pushChatMessage({
            senderId: req.user.id,
            receiverId: receiver.toString(),
            receiverRole,
            conversationId: conv._id.toString(),
            preview: previewContent,
        }).catch((err) => {
            logger_1.logger.warn(`chat push failed: ${err.message}`);
        });
    }
    res.status(201).json({ success: true, data: message });
});
const pushChatMessage = async (params) => {
    const sender = await User_1.User.findById(params.senderId)
        .select('profile.fullName email')
        .lean();
    const senderName = sender?.profile?.fullName?.trim() || sender?.email || 'New message';
    const body = params.preview.trim().length > 0 ? params.preview : 'sent a message';
    await (0, notify_service_1.notifyUser)({
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
exports.getSmartReplies = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const conv = await ensureParticipant(req.user._id, String(req.params.id));
    const recent = await Message_1.Message.find({ conversation: conv._id })
        .sort({ sentAt: -1 })
        .limit(8)
        .lean();
    const turns = recent
        .reverse()
        .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0)
        .map((m) => ({
        role: m.sender.toString() === req.user._id.toString()
            ? 'hirer'
            : 'candidate',
        text: m.content,
    }));
    const cached = await (0, chatSmartReply_service_1.suggestSmartReplies)({ turns, userId });
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (cached.cached) {
        res.json({ success: true, data: cached, quota });
        return;
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)('chat_smart_reply');
    if (weight > 0 && cached.usedAi && !cached.cached) {
        quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    }
    if (weight > 0 && !cached.usedAi) {
        await (0, quota_service_1.refundQuota)(userId, 0);
    }
    res.json({ success: true, data: cached, quota });
});
