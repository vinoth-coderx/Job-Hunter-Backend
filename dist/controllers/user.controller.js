"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateNotificationPrefs = exports.switchRole = exports.deleteAccount = exports.changePassword = exports.updateProfile = exports.notificationPrefsSchema = exports.switchRoleSchema = exports.changePasswordSchema = exports.updateResumeProfile = exports.updateResumeProfileSchema = exports.updateProfileSchema = void 0;
const zod_1 = require("zod");
const User_1 = require("../models/User");
const HirerProfile_1 = require("../models/HirerProfile");
const ApiError_1 = require("../utils/ApiError");
const asyncHandler_1 = require("../utils/asyncHandler");
const profileOptimizer_service_1 = require("../services/ai/profileOptimizer.service");
const coin_service_1 = require("../services/coins/coin.service");
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
const employmentEntrySchema = zod_1.z.object({
    designation: zod_1.z.string().max(120).default(''),
    company: zod_1.z.string().max(120).default(''),
    period: zod_1.z.string().max(80).default(''),
    current: zod_1.z.boolean().default(false),
});
const educationEntrySchema = zod_1.z.object({
    degree: zod_1.z.string().max(160).default(''),
    institute: zod_1.z.string().max(220).default(''),
    period: zod_1.z.string().max(80).default(''),
    type: zod_1.z.string().max(40).default('Full Time'),
    projects: zod_1.z.array(zod_1.z.string().max(160)).max(20).default([]),
});
const itSkillEntrySchema = zod_1.z.object({
    skill: zod_1.z.string().max(80).default(''),
    version: zod_1.z.string().max(20).default('-'),
    lastUsed: zod_1.z.string().max(20).default(''),
    experience: zod_1.z.string().max(40).default(''),
});
const projectEntrySchema = zod_1.z.object({
    title: zod_1.z.string().max(160).default(''),
    company: zod_1.z.string().max(120).default(''),
    type: zod_1.z.string().max(40).default('Full Time'),
    period: zod_1.z.string().max(80).default(''),
    description: zod_1.z.string().max(2000).default(''),
});
const languageEntrySchema = zod_1.z.object({
    language: zod_1.z.string().max(40).default(''),
    proficiency: zod_1.z.string().max(40).default('Intermediate'),
    read: zod_1.z.boolean().default(true),
    write: zod_1.z.boolean().default(true),
    speak: zod_1.z.boolean().default(true),
});
const accomplishmentEntrySchema = zod_1.z.object({
    type: zod_1.z.string().max(120).default(''),
    label: zod_1.z.string().max(200).default(''),
    value: zod_1.z.string().max(500).default(''),
});
const careerProfileSchema = zod_1.z.object({
    currentIndustry: zod_1.z.string().max(120).default(''),
    department: zod_1.z.string().max(120).default(''),
    roleCategory: zod_1.z.string().max(120).default(''),
    jobRole: zod_1.z.string().max(120).default(''),
    desiredJobType: zod_1.z.string().max(60).default(''),
    desiredEmploymentType: zod_1.z.string().max(60).default(''),
    preferredShift: zod_1.z.string().max(60).default(''),
    preferredLocation: zod_1.z.string().max(220).default(''),
    expectedSalary: zod_1.z.string().max(80).default(''),
});
const personalDetailsSchema = zod_1.z.object({
    gender: zod_1.z.string().max(20).default(''),
    maritalStatus: zod_1.z.string().max(30).default(''),
    dob: zod_1.z.string().max(30).default(''),
    category: zod_1.z.string().max(60).default(''),
    workPermit: zod_1.z.string().max(140).default(''),
    address: zod_1.z.string().max(400).default(''),
});
exports.updateResumeProfileSchema = zod_1.z.object({
    body: zod_1.z.object({
        headline: zod_1.z.string().max(200).optional(),
        skills: zod_1.z.array(zod_1.z.string()).max(50).optional(),
        experienceYears: zod_1.z.number().min(0).max(60).optional(),
        preferredLocations: zod_1.z.array(zod_1.z.string()).max(20).optional(),
        expectedSalaryMin: zod_1.z.number().min(0).optional(),
        profileSummary: zod_1.z.string().max(2000).optional(),
        employments: zod_1.z.array(employmentEntrySchema).max(15).optional(),
        educations: zod_1.z.array(educationEntrySchema).max(10).optional(),
        itSkills: zod_1.z.array(itSkillEntrySchema).max(25).optional(),
        projects: zod_1.z.array(projectEntrySchema).max(10).optional(),
        languages: zod_1.z.array(languageEntrySchema).max(10).optional(),
        accomplishments: zod_1.z.array(accomplishmentEntrySchema).max(20).optional(),
        careerProfile: careerProfileSchema.optional(),
        personalDetails: personalDetailsSchema.optional(),
        diversityNote: zod_1.z.string().max(1000).optional(),
    }),
});
const TOP_LEVEL_PROFILE_KEYS = new Set([
    'headline',
    'skills',
    'experienceYears',
    'preferredLocations',
    'expectedSalaryMin',
]);
exports.updateResumeProfile = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const updates = {};
    let touchedResumeProfile = false;
    for (const [key, value] of Object.entries(req.body)) {
        if (value === undefined)
            continue;
        if (TOP_LEVEL_PROFILE_KEYS.has(key)) {
            updates[`profile.${key}`] = value;
        }
        else {
            updates[`profile.resumeProfile.${key}`] = value;
            touchedResumeProfile = true;
        }
    }
    if (touchedResumeProfile) {
        updates['profile.resumeProfile.updatedAt'] = new Date();
    }
    const user = await User_1.User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true, runValidators: true });
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const completenessGrant = await (0, coin_service_1.maybeGrantProfileCompleteBonus)(user);
    await (0, profileOptimizer_service_1.invalidateProfileOptimizerCache)(String(user._id));
    res.json({
        success: true,
        data: user.profile.resumeProfile ?? {},
        coinsAwarded: completenessGrant?.amount ?? 0,
        coinsBalance: completenessGrant?.balance ?? user.gamification?.coins ?? 0,
    });
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
        aiPolish: zod_1.z.boolean().optional(),
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
    await (0, profileOptimizer_service_1.invalidateProfileOptimizerCache)(String(user._id));
    const completenessGrant = await (0, coin_service_1.maybeGrantProfileCompleteBonus)(user);
    res.json({
        success: true,
        message: 'Profile updated',
        data: user.profile,
        coinsAwarded: completenessGrant?.amount ?? 0,
        coinsBalance: completenessGrant?.balance ?? user.gamification?.coins ?? 0,
    });
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
