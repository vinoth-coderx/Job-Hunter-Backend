"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runNow = exports.todaySummary = exports.listLogs = exports.approveJobs = exports.getPreview = exports.approveSchema = exports.resumeAutoApply = exports.pauseAutoApply = exports.updateSettings = exports.getSettings = exports.pauseSchema = exports.updateSettingsSchema = void 0;
const zod_1 = require("zod");
const AutoApplySettings_1 = require("../models/AutoApplySettings");
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const limits_1 = require("../services/autoApply/limits");
const runner_1 = require("../services/autoApply/runner");
const AutoApplyLog_1 = require("../models/AutoApplyLog");
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const preferencesSchema = zod_1.z.object({
    targetRoles: zod_1.z.array(zod_1.z.string().min(1).max(100)).max(20).optional(),
    locations: zod_1.z.array(zod_1.z.string().min(1).max(100)).max(30).optional(),
    isOpenToRemote: zod_1.z.boolean().optional(),
    jobTypes: zod_1.z
        .array(zod_1.z.enum(['full-time', 'part-time', 'contract', 'internship', 'temporary']))
        .max(5)
        .optional(),
    minSalary: zod_1.z.coerce.number().min(0).optional(),
    experienceLevels: zod_1.z.array(zod_1.z.string().min(1).max(50)).max(10).optional(),
    sources: zod_1.z.array(zod_1.z.enum(['native', 'external'])).max(2).optional(),
    companySizes: zod_1.z.array(zod_1.z.string().min(1).max(20)).max(10).optional(),
});
const matchingRulesSchema = zod_1.z.object({
    minMatchPercentage: zod_1.z.coerce.number().min(50).max(95).optional(),
    minSkillsMatchCount: zod_1.z.coerce.number().int().min(0).max(10).optional(),
    mustIncludeKeywords: zod_1.z.array(zod_1.z.string().min(1).max(50)).max(20).optional(),
    excludeKeywords: zod_1.z.array(zod_1.z.string().min(1).max(50)).max(20).optional(),
    blacklistedCompanies: zod_1.z.array(zod_1.z.string().min(1).max(100)).max(50).optional(),
    reapplyCooldownDays: zod_1.z.union([zod_1.z.literal(30), zod_1.z.literal(60), zod_1.z.literal(90)]).optional(),
});
const aiCoverLetterSchema = zod_1.z.object({
    enabled: zod_1.z.boolean().optional(),
    tone: zod_1.z.enum(['professional', 'friendly', 'technical']).optional(),
    baseTemplate: zod_1.z.string().max(4000).optional(),
});
exports.updateSettingsSchema = zod_1.z.object({
    body: zod_1.z.object({
        isEnabled: zod_1.z.boolean().optional(),
        runTime: zod_1.z.string().regex(TIME_REGEX, 'Format HH:mm').optional(),
        runDays: zod_1.z
            .array(zod_1.z.enum([
            'monday',
            'tuesday',
            'wednesday',
            'thursday',
            'friday',
            'saturday',
            'sunday',
        ]))
            .min(1)
            .max(7)
            .optional(),
        dailyLimit: zod_1.z.coerce.number().int().min(1).max(50).optional(),
        preferences: preferencesSchema.optional(),
        matchingRules: matchingRulesSchema.optional(),
        reviewMode: zod_1.z.boolean().optional(),
        aiCoverLetter: aiCoverLetterSchema.optional(),
    }),
});
exports.pauseSchema = zod_1.z.object({
    body: zod_1.z.object({
        days: zod_1.z.union([zod_1.z.literal(1), zod_1.z.literal(3), zod_1.z.literal(7)]).optional(),
        reason: zod_1.z.string().max(500).optional(),
    }),
});
const requireTier = async (userId) => {
    const user = await User_1.User.findById(userId).select('subscription').lean();
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const rawTier = (user.subscription?.tier ?? 'free');
    const trial = (0, limits_1.computeTrialState)(user.subscription);
    return { rawTier, tier: (0, limits_1.effectiveTier)(rawTier, trial), trial };
};
const ensureTrialStarted = async (userId) => {
    const ctx = await requireTier(userId);
    if (ctx.rawTier === 'free' && !ctx.trial.used) {
        const now = new Date();
        await User_1.User.updateOne({ _id: userId }, {
            $set: {
                'subscription.trialActivatedAt': now,
                'subscription.trialUsed': true,
            },
        });
        return requireTier(userId);
    }
    return ctx;
};
const sanitiseSettings = (s, ctx) => ({
    id: s._id.toString(),
    isEnabled: s.isEnabled,
    isPaused: s.isPaused,
    pauseUntil: s.pauseUntil,
    pauseReason: s.pauseReason,
    runTime: s.runTime,
    runDays: s.runDays,
    dailyLimit: s.dailyLimit,
    preferences: s.preferences,
    matchingRules: s.matchingRules,
    reviewMode: s.reviewMode,
    aiCoverLetter: s.aiCoverLetter,
    totalAutoApplied: s.totalAutoApplied,
    lastRunAt: s.lastRunAt,
    tier: ctx.tier,
    planCap: limits_1.AUTO_APPLY_DAILY_CAP[ctx.tier],
    eligible: (0, limits_1.isAutoApplyEligible)(ctx.tier),
    trial: {
        active: ctx.trial.active,
        used: ctx.trial.used,
        endsAt: ctx.trial.endsAt,
        durationDays: limits_1.TRIAL_DURATION_DAYS,
    },
});
exports.getSettings = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const ctx = await ensureTrialStarted(req.user.id);
    let settings = await AutoApplySettings_1.AutoApplySettings.findOne({ user: req.user._id });
    if (!settings) {
        settings = await AutoApplySettings_1.AutoApplySettings.create({
            user: req.user._id,
            isEnabled: false,
            dailyLimit: Math.max(1, limits_1.AUTO_APPLY_DAILY_CAP[ctx.tier] || 10),
        });
    }
    res.json({ success: true, data: sanitiseSettings(settings, ctx) });
});
exports.updateSettings = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const ctx = await requireTier(req.user.id);
    const body = req.body;
    if (body.isEnabled === true && !(0, limits_1.isAutoApplyEligible)(ctx.tier)) {
        throw ApiError_1.ApiError.forbidden('Auto-Apply requires a Monthly or Yearly subscription. Upgrade to enable.');
    }
    let settings = await AutoApplySettings_1.AutoApplySettings.findOne({ user: req.user._id });
    if (!settings) {
        settings = await AutoApplySettings_1.AutoApplySettings.create({
            user: req.user._id,
            dailyLimit: Math.max(1, limits_1.AUTO_APPLY_DAILY_CAP[ctx.tier] || 10),
        });
    }
    if (body.isEnabled !== undefined)
        settings.isEnabled = body.isEnabled;
    if (body.runTime !== undefined)
        settings.runTime = body.runTime;
    if (body.runDays !== undefined)
        settings.runDays = body.runDays;
    if (body.dailyLimit !== undefined) {
        settings.dailyLimit = (0, limits_1.cappedDailyLimit)(body.dailyLimit, ctx.tier);
    }
    if (body.preferences) {
        settings.preferences = {
            ...settings.preferences,
            ...body.preferences,
        };
    }
    if (body.matchingRules) {
        settings.matchingRules = {
            ...settings.matchingRules,
            ...body.matchingRules,
        };
    }
    if (body.reviewMode !== undefined)
        settings.reviewMode = body.reviewMode;
    if (body.aiCoverLetter) {
        settings.aiCoverLetter = {
            ...settings.aiCoverLetter,
            ...body.aiCoverLetter,
        };
    }
    if (body.isEnabled === true) {
        settings.isPaused = false;
        settings.pauseUntil = undefined;
        settings.pauseReason = undefined;
    }
    await settings.save();
    res.json({ success: true, data: sanitiseSettings(settings, ctx) });
});
exports.pauseAutoApply = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const ctx = await requireTier(req.user.id);
    const { days, reason } = req.body;
    const settings = await AutoApplySettings_1.AutoApplySettings.findOne({ user: req.user._id });
    if (!settings)
        throw ApiError_1.ApiError.notFound('Auto-apply not configured');
    settings.isPaused = true;
    if (days) {
        settings.pauseUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    }
    else {
        settings.pauseUntil = undefined;
    }
    if (reason)
        settings.pauseReason = reason;
    await settings.save();
    res.json({ success: true, data: sanitiseSettings(settings, ctx) });
});
exports.resumeAutoApply = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const ctx = await requireTier(req.user.id);
    const settings = await AutoApplySettings_1.AutoApplySettings.findOne({ user: req.user._id });
    if (!settings)
        throw ApiError_1.ApiError.notFound('Auto-apply not configured');
    if (!(0, limits_1.isAutoApplyEligible)(ctx.tier)) {
        throw ApiError_1.ApiError.forbidden('Auto-Apply requires a Monthly or Yearly subscription.');
    }
    settings.isPaused = false;
    settings.pauseUntil = undefined;
    settings.pauseReason = undefined;
    await settings.save();
    res.json({ success: true, data: sanitiseSettings(settings, ctx) });
});
exports.approveSchema = zod_1.z.object({
    body: zod_1.z.object({
        logId: zod_1.z.string().min(1),
        jobIds: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(50),
    }),
});
exports.getPreview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const log = await AutoApplyLog_1.AutoApplyLog.findOne({
        user: req.user._id,
        awaitingApproval: true,
    })
        .sort({ runDate: -1 })
        .populate({
        path: 'appliedJobs.job',
        select: 'title company location skills salaryMin salaryMax remoteType jobType companyLogoUrl status isActive',
    })
        .lean();
    if (!log) {
        res.json({ success: true, data: null });
        return;
    }
    res.json({
        success: true,
        data: {
            logId: log._id.toString(),
            runDate: log.runDate,
            jobsScanned: log.jobsScanned,
            jobsMatched: log.jobsMatched,
            candidates: (log.appliedJobs ?? []).map((a) => {
                const jobObj = a.job;
                let jobId = '';
                if (jobObj && typeof jobObj === 'object' && '_id' in jobObj) {
                    jobId = String(jobObj._id);
                }
                else if (jobObj) {
                    jobId = String(jobObj);
                }
                return {
                    applicationId: null,
                    jobId,
                    job: a.job,
                    companyName: a.companyName,
                    jobTitle: a.jobTitle,
                    matchScore: a.matchScore,
                    source: a.source,
                    status: a.status,
                };
            }),
        },
    });
});
exports.approveJobs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { logId, jobIds } = req.body;
    const log = await AutoApplyLog_1.AutoApplyLog.findOne({
        _id: logId,
        user: req.user._id,
        awaitingApproval: true,
    });
    if (!log)
        throw ApiError_1.ApiError.notFound('Review batch not found or already finalised');
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const { applied, failed } = await (0, runner_1.submitApprovedApplications)(user, jobIds);
    for (const entry of log.appliedJobs) {
        const jid = entry.job.toString();
        const ok = applied.find((a) => a.job.toString() === jid);
        const fail = failed.find((f) => f.jobId === jid);
        if (ok) {
            entry.application = ok.application;
            entry.appliedAt = ok.appliedAt;
            entry.status = 'applied';
        }
        else if (fail) {
            entry.status = `failed:${fail.error.slice(0, 80)}`;
        }
        else if (jobIds.includes(jid)) {
            entry.status = 'failed:unknown';
        }
        else {
            entry.status = 'skipped';
        }
    }
    log.jobsApplied = applied.length;
    log.awaitingApproval = false;
    log.approvalCompletedAt = new Date();
    await log.save();
    res.json({
        success: true,
        data: {
            applied: applied.length,
            failed: failed.length,
            skipped: log.appliedJobs.length - applied.length - failed.length,
        },
    });
});
exports.listLogs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(50, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20);
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        AutoApplyLog_1.AutoApplyLog.find({ user: req.user._id })
            .sort({ runDate: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        AutoApplyLog_1.AutoApplyLog.countDocuments({ user: req.user._id }),
    ]);
    res.json({
        success: true,
        data: items,
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
        },
    });
});
exports.todaySummary = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const log = await AutoApplyLog_1.AutoApplyLog.findOne({
        user: req.user._id,
        runDate: { $gte: since },
    })
        .sort({ runDate: -1 })
        .lean();
    res.json({ success: true, data: log });
});
exports.runNow = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const ctx = await requireTier(req.user.id);
    if (!(0, limits_1.isAutoApplyEligible)(ctx.tier)) {
        throw ApiError_1.ApiError.forbidden('Auto-Apply requires a paid plan');
    }
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const outcome = await (0, runner_1.runAutoApplyForUser)(user, { manual: true });
    if (!outcome) {
        throw ApiError_1.ApiError.badRequest('Auto-Apply is disabled or paused; enable it before running.');
    }
    res.json({ success: true, data: outcome });
});
