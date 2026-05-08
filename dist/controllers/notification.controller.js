"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteNotification = exports.markAllRead = exports.markRead = exports.unreadCount = exports.listNotifications = void 0;
const Notification_1 = require("../models/Notification");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
const parsePagination = (q) => {
    const pageRaw = typeof q.page === 'string' ? Number(q.page) : NaN;
    const limitRaw = typeof q.limit === 'string' ? Number(q.limit) : NaN;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 30);
    return { page, limit, skip: (page - 1) * limit };
};
exports.listNotifications = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const q = req.query;
    const filter = { user: req.user._id };
    if (typeof q.role === 'string' && (q.role === 'seeker' || q.role === 'hirer')) {
        filter.role = q.role;
    }
    if (q.unread === 'true')
        filter.isRead = false;
    const { page, limit, skip } = parsePagination(q);
    const [items, total, unread] = await Promise.all([
        Notification_1.Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Notification_1.Notification.countDocuments(filter),
        Notification_1.Notification.countDocuments({ user: req.user._id, isRead: false }),
    ]);
    res.json({
        success: true,
        data: items,
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
            unread,
        },
    });
});
exports.unreadCount = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const count = await Notification_1.Notification.countDocuments({ user: req.user._id, isRead: false });
    res.json({ success: true, data: { unread: count } });
});
exports.markRead = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid notification id');
    const result = await Notification_1.Notification.updateOne({ _id: id, user: req.user._id, isRead: false }, { $set: { isRead: true, readAt: new Date() } });
    res.json({ success: true, data: { modified: result.modifiedCount } });
});
exports.markAllRead = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const result = await Notification_1.Notification.updateMany({ user: req.user._id, isRead: false }, { $set: { isRead: true, readAt: new Date() } });
    res.json({ success: true, data: { modified: result.modifiedCount } });
});
exports.deleteNotification = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid notification id');
    await Notification_1.Notification.deleteOne({ _id: id, user: req.user._id });
    res.json({ success: true });
});
