"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateNotificationPrefs = exports.switchRole = exports.deleteAccount = exports.changePassword = exports.updateProfile = exports.notificationPrefsSchema = exports.switchRoleSchema = exports.changePasswordSchema = exports.updateProfileSchema = void 0;
const zod_1 = require("zod");
const User_1 = require("../models/User");
const HirerProfile_1 = require("../models/HirerProfile");
const ApiError_1 = require("../utils/ApiError");
const asyncHandler_1 = require("../utils/asyncHandler");
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
exports.switchRoleSchema = zod_1.z.object({
    body: zod_1.z.object({
        role: zod_1.z.enum(['seeker', 'hirer']),
    }),
});
exports.notificationPrefsSchema = zod_1.z.object({
    body: zod_1.z.object({
        push: zod_1.z.boolean().optional(),
        email: zod_1.z.boolean().optional(),
        whatsapp: zod_1.z.boolean().optional(),
        jobAlerts: zod_1.z.boolean().optional(),
        applicationUpdates: zod_1.z.boolean().optional(),
        autoApplySummary: zod_1.z.boolean().optional(),
        quietHoursStart: zod_1.z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .optional(),
        quietHoursEnd: zod_1.z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .optional(),
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
    res.json({ success: true, message: 'Account deleted' });
});
exports.switchRole = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { role } = req.body;
    if (role === 'hirer') {
        const profile = await HirerProfile_1.HirerProfile.findOne({ user: req.user._id }).select('_id').lean();
        if (!profile) {
            throw ApiError_1.ApiError.conflict('Set up a company profile before switching to hirer mode');
        }
    }
    const user = await User_1.User.findByIdAndUpdate(req.user._id, { $set: { activeRole: role } }, { new: true });
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    res.json({
        success: true,
        data: { activeRole: user.activeRole },
    });
});
exports.updateNotificationPrefs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const body = req.body;
    const updates = {};
    for (const [k, v] of Object.entries(body)) {
        if (v !== undefined)
            updates[`notificationPreferences.${k}`] = v;
    }
    const user = await User_1.User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true }).select('notificationPreferences');
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    res.json({
        success: true,
        data: user.notificationPreferences,
    });
});
