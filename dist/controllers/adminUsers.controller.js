"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserTrust = exports.unbanUser = exports.banUser = exports.updateUser = exports.getUser = exports.userStats = exports.listUsers = void 0;
const mongoose_1 = require("mongoose");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const User_1 = require("../models/User");
const UserSession_1 = require("../models/UserSession");
const SecurityEvent_1 = require("../models/SecurityEvent");
const session_service_1 = require("../services/security/session.service");
const toAdminUser = (u) => ({
    _id: u._id.toString(),
    email: u.email,
    activeRole: u.isAdmin ? 'admin' : u.activeRole,
    isEmailVerified: u.isEmailVerified,
    isPhoneVerified: u.isPhoneVerified ?? false,
    isBanned: u.isBanned,
    banReason: u.banReason,
    profile: {
        fullName: u.profile?.fullName ?? '',
        avatarUrl: u.profile?.avatar,
        phone: u.profile?.phone,
    },
    subscription: {
        tier: u.subscription?.tier ?? 'free',
        status: u.subscription?.status ?? 'active',
        endDate: u.subscription?.endDate?.toISOString(),
    },
    twoFactor: u.twoFactor
        ? {
            enabled: u.twoFactor.enabled ?? false,
            method: u.twoFactor.method,
            enrolledAt: u.twoFactor.enrolledAt?.toISOString(),
        }
        : { enabled: false },
    security: u.security
        ? {
            trustScore: u.security.trustScore,
            failedLoginCount: u.security.failedLoginCount,
            lockedUntil: u.security.lockedUntil?.toISOString(),
            lastSeenIp: u.security.lastSeenIp,
        }
        : undefined,
    privacy: u.privacy
        ? {
            openToWork: u.privacy.openToWork,
            resumeVisibility: u.privacy.resumeVisibility,
        }
        : undefined,
    createdAt: u.createdAt.toISOString(),
    lastSeenAt: u.lastLogin?.toISOString(),
});
const SELECT_FIELDS = 'email activeRole isAdmin isBanned bannedAt banReason isEmailVerified isPhoneVerified profile.fullName profile.avatar profile.phone subscription twoFactor.enabled twoFactor.method twoFactor.enrolledAt security.trustScore security.failedLoginCount security.lockedUntil security.lastSeenIp privacy.openToWork privacy.resumeVisibility lastLogin createdAt';
exports.listUsers = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const q = req.query.q?.trim();
    const role = req.query.role ?? 'all';
    const status = req.query.status ?? 'all';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.perPage, 10) || 20));
    const filter = {};
    if (q) {
        filter.$or = [
            { email: { $regex: q, $options: 'i' } },
            { 'profile.fullName': { $regex: q, $options: 'i' } },
        ];
    }
    if (role === 'admin') {
        filter.isAdmin = true;
    }
    else if (role === 'seeker' || role === 'hirer') {
        filter.activeRole = role;
        filter.isAdmin = { $ne: true };
    }
    if (status === 'banned')
        filter.isBanned = true;
    else if (status === 'verified')
        filter.isEmailVerified = true;
    else if (status === 'unverified')
        filter.isEmailVerified = false;
    const [users, total] = await Promise.all([
        User_1.User.find(filter)
            .select(SELECT_FIELDS)
            .sort({ createdAt: -1 })
            .skip((page - 1) * perPage)
            .limit(perPage)
            .lean(),
        User_1.User.countDocuments(filter),
    ]);
    res.json({
        users: users.map(toAdminUser),
        total,
        page,
        perPage,
    });
});
exports.userStats = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const [totalUsers, totalSeekers, totalHirers, totalAdmins, totalVerified, totalBanned, newToday, newThisWeek, activeToday,] = await Promise.all([
        User_1.User.countDocuments({}),
        User_1.User.countDocuments({ activeRole: 'seeker', isAdmin: { $ne: true } }),
        User_1.User.countDocuments({ activeRole: 'hirer', isAdmin: { $ne: true } }),
        User_1.User.countDocuments({ isAdmin: true }),
        User_1.User.countDocuments({ isEmailVerified: true }),
        User_1.User.countDocuments({ isBanned: true }),
        User_1.User.countDocuments({ createdAt: { $gte: startOfToday } }),
        User_1.User.countDocuments({ createdAt: { $gte: startOfWeek } }),
        User_1.User.countDocuments({ lastLogin: { $gte: startOfYesterday } }),
    ]);
    res.json({
        totalUsers,
        totalSeekers,
        totalHirers,
        totalAdmins,
        totalVerified,
        totalBanned,
        newToday,
        newThisWeek,
        activeToday,
    });
});
const requireObjectId = (id) => {
    if (typeof id !== 'string' || !mongoose_1.Types.ObjectId.isValid(id)) {
        throw ApiError_1.ApiError.badRequest('Invalid user id');
    }
    return new mongoose_1.Types.ObjectId(id);
};
exports.getUser = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const u = await User_1.User.findById(id).select(SELECT_FIELDS).lean();
    if (!u)
        throw ApiError_1.ApiError.notFound('User not found');
    res.json(toAdminUser(u));
});
exports.updateUser = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const { fullName, activeRole, isEmailVerified } = req.body ?? {};
    const update = {};
    if (typeof fullName === 'string') {
        update['profile.fullName'] = fullName.trim();
    }
    if (typeof isEmailVerified === 'boolean') {
        update.isEmailVerified = isEmailVerified;
    }
    if (activeRole === 'admin') {
        update.isAdmin = true;
    }
    else if (activeRole === 'seeker' || activeRole === 'hirer') {
        update.activeRole = activeRole;
        update.isAdmin = false;
    }
    else if (activeRole !== undefined) {
        throw ApiError_1.ApiError.badRequest('activeRole must be one of seeker | hirer | admin');
    }
    if (Object.keys(update).length === 0) {
        throw ApiError_1.ApiError.badRequest('No updatable fields supplied');
    }
    if (req.user?.id === id.toString() && update.isAdmin === false) {
        throw ApiError_1.ApiError.badRequest("You can't remove your own admin role — promote another user first.");
    }
    const updated = await User_1.User.findByIdAndUpdate(id, update, {
        new: true,
    })
        .select(SELECT_FIELDS)
        .lean();
    if (!updated)
        throw ApiError_1.ApiError.notFound('User not found');
    res.json(toAdminUser(updated));
});
exports.banUser = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = requireObjectId(req.params.id);
    if (req.user?.id === id.toString()) {
        throw ApiError_1.ApiError.badRequest("You can't ban your own account.");
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined;
    const updated = await User_1.User.findByIdAndUpdate(id, {
        isBanned: true,
        bannedAt: new Date(),
        banReason: reason,
        $unset: { refreshTokens: '' },
    }, { new: true })
        .select(SELECT_FIELDS)
        .lean();
    if (!updated)
        throw ApiError_1.ApiError.notFound('User not found');
    res.json(toAdminUser(updated));
});
exports.unbanUser = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const updated = await User_1.User.findByIdAndUpdate(id, {
        isBanned: false,
        $unset: { bannedAt: '', banReason: '' },
    }, { new: true })
        .select(SELECT_FIELDS)
        .lean();
    if (!updated)
        throw ApiError_1.ApiError.notFound('User not found');
    res.json(toAdminUser(updated));
});
exports.getUserTrust = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const [sessions, recentEvents, sessionCount] = await Promise.all([
        (0, session_service_1.listActiveSessions)(id),
        SecurityEvent_1.SecurityEvent.find({ user: id })
            .sort({ createdAt: -1 })
            .limit(20)
            .lean(),
        UserSession_1.UserSession.countDocuments({ user: id }),
    ]);
    res.json({
        sessions,
        sessionCount,
        recentEvents,
    });
});
