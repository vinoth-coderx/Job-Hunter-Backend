"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAccount = exports.changePassword = exports.updateProfile = exports.changePasswordSchema = exports.updateProfileSchema = void 0;
const zod_1 = require("zod");
const User_1 = require("../models/User");
const ApiError_1 = require("../utils/ApiError");
const asyncHandler_1 = require("../utils/asyncHandler");
const redis_1 = require("../config/redis");
exports.updateProfileSchema = zod_1.z.object({
    body: zod_1.z.object({
        fullName: zod_1.z.string().min(2).max(100).optional(),
        phone: zod_1.z.string().optional(),
        headline: zod_1.z.string().max(200).optional(),
        skills: zod_1.z.array(zod_1.z.string()).max(50).optional(),
        experienceYears: zod_1.z.number().min(0).max(60).optional(),
        preferredRoles: zod_1.z.array(zod_1.z.string()).max(20).optional(),
        preferredLocations: zod_1.z.array(zod_1.z.string()).max(20).optional(),
        preferredJobTypes: zod_1.z
            .array(zod_1.z.enum(['full-time', 'part-time', 'contract', 'internship', 'temporary', 'unknown']))
            .optional(),
        preferredRemote: zod_1.z.array(zod_1.z.enum(['remote', 'hybrid', 'onsite', 'unknown'])).optional(),
        expectedSalaryMin: zod_1.z.number().min(0).optional(),
        resumeUrl: zod_1.z.string().url().optional(),
        resumeText: zod_1.z.string().max(20000).optional(),
        avatar: zod_1.z.string().url().optional(),
    }),
});
exports.changePasswordSchema = zod_1.z.object({
    body: zod_1.z.object({
        currentPassword: zod_1.z.string().min(1),
        newPassword: zod_1.z.string().min(8).max(100),
    }),
});
exports.updateProfile = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const updates = {};
    for (const [key, value] of Object.entries(req.body)) {
        updates[`profile.${key}`] = value;
    }
    const user = await User_1.User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true, runValidators: true });
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    await redis_1.redis.del(redis_1.CACHE_KEYS.USER_PROFILE(req.user.id));
    const matchKeys = await redis_1.redis.keys(`match:${req.user.id}:*`);
    if (matchKeys.length)
        await redis_1.redis.del(...matchKeys);
    await redis_1.redis.del(redis_1.CACHE_KEYS.USER_MATCHED_JOBS(req.user.id));
    res.json({ success: true, message: 'Profile updated', data: user.profile });
});
exports.changePassword = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { currentPassword, newPassword } = req.body;
    const user = await User_1.User.findById(req.user._id).select('+password');
    if (!user || !user.password)
        throw ApiError_1.ApiError.badRequest('Password change unavailable for this account');
    const valid = await user.comparePassword(currentPassword);
    if (!valid)
        throw ApiError_1.ApiError.unauthorized('Current password is incorrect');
    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: 'Password changed' });
});
exports.deleteAccount = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    await User_1.User.findByIdAndDelete(req.user._id);
    await redis_1.redis.del(redis_1.CACHE_KEYS.USER_PROFILE(req.user.id));
    res.json({ success: true, message: 'Account deleted' });
});
