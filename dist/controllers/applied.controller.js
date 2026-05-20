"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appliedStats = exports.deleteApplied = exports.updateApplied = exports.listApplied = exports.quickApply = exports.applyToJob = exports.updateAppliedSchema = exports.quickApplySchema = exports.applySchema = void 0;
const zod_1 = require("zod");
const Job_1 = require("../models/Job");
const AppliedJob_1 = require("../models/AppliedJob");
const HirerProfile_1 = require("../models/HirerProfile");
const notify_service_1 = require("../services/notification/notify.service");
const socket_1 = require("../services/chat/socket");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const matcher_service_1 = require("../services/ai/matcher.service");
const User_1 = require("../models/User");
const jobScraper_cron_1 = require("../jobs/jobScraper.cron");
const coin_service_1 = require("../services/coins/coin.service");
const jobFeed_service_1 = require("../services/jobFeed.service");
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const EXTERNAL_ID_RE = /^([a-z][a-z0-9_]*):(.+)$/i;
const APPLIED_SOURCE_ENUM = new Set([
    'native',
    'indeed',
    'naukri',
    'linkedin',
    'other',
]);
const toAppliedSource = (src) => (APPLIED_SOURCE_ENUM.has(src) ? src : 'other');
const APPLY_COIN_AMOUNT = 5;
const APPLY_DAILY_CAP = 50;
exports.applySchema = zod_1.z.object({
    body: zod_1.z.object({
        jobId: zod_1.z.string().min(1),
        notes: zod_1.z.string().max(2000).optional(),
    }),
});
exports.quickApplySchema = zod_1.z.object({
    body: zod_1.z.object({
        jobId: zod_1.z.string().min(1),
        quickNote: zod_1.z.string().max(500).optional(),
        screeningAnswers: zod_1.z
            .array(zod_1.z.object({
            question: zod_1.z.string().min(1).max(500),
            answer: zod_1.z.string().min(1).max(2000),
        }))
            .max(10)
            .optional(),
    }),
});
exports.updateAppliedSchema = zod_1.z.object({
    body: zod_1.z.object({
        status: zod_1.z.enum(['withdrawn']).optional(),
        notes: zod_1.z.string().max(2000).optional(),
        followUpDate: zod_1.z.string().datetime().optional(),
    }),
});
exports.applyToJob = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { jobId, notes } = req.body;
    const extMatch = EXTERNAL_ID_RE.exec(jobId);
    if (!OBJECT_ID_RE.test(jobId) && extMatch) {
        const source = extMatch[1];
        const externalId = extMatch[2];
        const dup = await AppliedJob_1.AppliedJob.findOne({
            user: req.user._id,
            'jobSnapshot.source': source,
            'jobSnapshot.externalId': externalId,
        });
        if (dup)
            throw ApiError_1.ApiError.conflict('You have already applied to this job');
        const cached = await (0, jobFeed_service_1.lookupExternalJobFromCache)(source, externalId);
        if (!cached) {
            throw ApiError_1.ApiError.badRequest('This listing has expired from cache. Re-open it from search results and try again.');
        }
        const user = await User_1.User.findById(req.user._id);
        const score = user
            ? (0, matcher_service_1.heuristicMatch)(user, {
                id: jobId,
                title: cached.title,
                company: cached.company,
                description: cached.description,
                location: cached.location,
                skills: cached.skills,
                remoteType: cached.remoteType,
                jobType: cached.jobType,
                salaryMin: cached.salaryMin,
                salaryMax: cached.salaryMax,
            }).score
            : undefined;
        const applied = await AppliedJob_1.AppliedJob.create({
            user: req.user._id,
            jobSnapshot: {
                title: cached.title,
                company: cached.company,
                location: cached.location,
                url: cached.applyUrl || cached.url,
                description: cached.description,
                salaryMin: cached.salaryMin,
                salaryMax: cached.salaryMax,
                currency: cached.currency,
                jobType: cached.jobType,
                remoteType: cached.remoteType,
                skills: cached.skills,
                companyLogo: cached.companyLogoUrl,
                postedAt: cached.postedAt,
                source,
                externalId,
            },
            applyType: 'external_manual',
            source: toAppliedSource(source),
            notes,
            matchScore: score,
            status: 'applied',
            statusHistory: [
                { status: 'applied', changedAt: new Date(), changedBy: req.user._id },
            ],
        });
        const coinGrant = await (0, coin_service_1.grantCoins)({
            user: req.user.id,
            amount: APPLY_COIN_AMOUNT,
            source: 'apply',
            idempotencyKey: `apply:${applied._id.toString()}`,
            sourceRefId: applied._id.toString(),
            dailyCap: APPLY_DAILY_CAP,
        });
        res.status(201).json({
            success: true,
            message: 'Marked as applied',
            data: applied,
            coinsAwarded: coinGrant.amount,
            coinsBalance: coinGrant.balance,
        });
        return;
    }
    if (!OBJECT_ID_RE.test(jobId)) {
        throw ApiError_1.ApiError.badRequest('Invalid jobId');
    }
    const job = await Job_1.Job.findById(jobId);
    if (!job)
        throw ApiError_1.ApiError.notFound('Job not found');
    const exists = await AppliedJob_1.AppliedJob.findOne({ user: req.user._id, job: jobId });
    if (exists)
        throw ApiError_1.ApiError.conflict('You have already applied to this job');
    const user = await User_1.User.findById(req.user._id);
    const score = user ? (0, matcher_service_1.heuristicMatch)(user, (0, matcher_service_1.toMatchable)(job)).score : undefined;
    const applied = await AppliedJob_1.AppliedJob.create({
        user: req.user._id,
        job: job._id,
        hirerProfile: job.hirerProfile,
        jobSnapshot: {
            title: job.title,
            company: job.company,
            location: job.location,
            url: job.applyUrl || job.url,
            description: job.description,
            salaryMin: job.salaryMin,
            salaryMax: job.salaryMax,
            currency: job.currency,
            jobType: job.jobType,
            remoteType: job.remoteType,
            skills: job.skills,
            companyLogo: job.companyLogoUrl,
            postedAt: job.postedAt,
            source: job.source,
            externalId: job.externalId,
        },
        applyType: job.isNative ? 'one_click' : 'external_manual',
        source: job.isNative ? 'native' : toAppliedSource(job.source || 'other'),
        notes,
        matchScore: score,
        status: 'applied',
        statusHistory: [
            { status: 'applied', changedAt: new Date(), changedBy: req.user._id },
        ],
    });
    if (job.isNative) {
        await Job_1.Job.updateOne({ _id: job._id }, { $inc: { applicationsCount: 1 } });
    }
    if (job.hirerProfile) {
        const hirer = await HirerProfile_1.HirerProfile.findById(job.hirerProfile).select('user').lean();
        if (hirer?.user) {
            try {
                await (0, notify_service_1.notifyUser)({
                    user: hirer.user,
                    role: 'hirer',
                    type: 'new_applicant',
                    title: 'New applicant',
                    body: `${user?.profile.fullName ?? 'A candidate'} applied to "${job.title}"`,
                    data: {
                        applicationId: applied._id.toString(),
                        jobId: job._id.toString(),
                        matchScore: score,
                    },
                });
                (0, socket_1.emitToUser)(hirer.user.toString(), 'applicant:new', {
                    applicationId: applied._id.toString(),
                    jobId: job._id.toString(),
                    matchScore: score,
                });
            }
            catch {
            }
        }
    }
    const coinGrant = await (0, coin_service_1.grantCoins)({
        user: req.user.id,
        amount: APPLY_COIN_AMOUNT,
        source: 'apply',
        idempotencyKey: `apply:${applied._id.toString()}`,
        sourceRefId: applied._id.toString(),
        dailyCap: APPLY_DAILY_CAP,
    });
    res.status(201).json({
        success: true,
        message: 'Marked as applied',
        data: applied,
        coinsAwarded: coinGrant.amount,
        coinsBalance: coinGrant.balance,
    });
});
exports.quickApply = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { jobId, quickNote, screeningAnswers } = req.body;
    const job = await Job_1.Job.findById(jobId);
    if (!job)
        throw ApiError_1.ApiError.notFound('Job not found');
    if (!job.isNative) {
        throw ApiError_1.ApiError.badRequest('This job uses external apply; use the WebView flow');
    }
    if (job.status !== 'active' || !job.isActive) {
        throw ApiError_1.ApiError.badRequest(`Job is not accepting applications (status: ${job.status})`);
    }
    if (job.applicationDeadline && job.applicationDeadline < new Date()) {
        throw ApiError_1.ApiError.badRequest('Application deadline has passed');
    }
    const exists = await AppliedJob_1.AppliedJob.findOne({ user: req.user._id, job: job._id });
    if (exists)
        throw ApiError_1.ApiError.conflict('You have already applied to this job');
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    if (!user.profile.resumeUrl && !user.profile.resumeFile) {
        throw ApiError_1.ApiError.badRequest('Upload a resume on your profile before applying');
    }
    if (job.screeningQuestions && job.screeningQuestions.length > 0) {
        const requiredQs = job.screeningQuestions.filter((q) => q.isRequired);
        const provided = new Map((screeningAnswers ?? []).map((a) => [a.question.trim(), a.answer.trim()]));
        for (const q of requiredQs) {
            const a = provided.get(q.question.trim());
            if (!a || a.length === 0) {
                throw ApiError_1.ApiError.badRequest(`Required question not answered: "${q.question}"`);
            }
        }
    }
    const score = (0, matcher_service_1.heuristicMatch)(user, (0, matcher_service_1.toMatchable)(job)).score;
    const applied = await AppliedJob_1.AppliedJob.create({
        user: req.user._id,
        job: job._id,
        hirerProfile: job.hirerProfile,
        jobSnapshot: {
            title: job.title,
            company: job.company,
            location: job.location,
            url: job.applyUrl || job.url,
            description: job.description,
            salaryMin: job.salaryMin,
            salaryMax: job.salaryMax,
            currency: job.currency,
            jobType: job.jobType,
            remoteType: job.remoteType,
            skills: job.skills,
            companyLogo: job.companyLogoUrl,
            postedAt: job.postedAt,
            source: job.source,
            externalId: job.externalId,
        },
        applyType: 'one_click',
        source: 'native',
        resumeUrlSnapshot: user.profile.resumeUrl,
        quickNote,
        screeningAnswers,
        matchScore: score,
        status: 'applied',
        statusHistory: [{ status: 'applied', changedAt: new Date(), changedBy: req.user._id }],
    });
    await Job_1.Job.updateOne({ _id: job._id }, { $inc: { applicationsCount: 1 } });
    const coinGrant = await (0, coin_service_1.grantCoins)({
        user: req.user.id,
        amount: APPLY_COIN_AMOUNT,
        source: 'apply',
        idempotencyKey: `apply:${applied._id.toString()}`,
        sourceRefId: applied._id.toString(),
        dailyCap: APPLY_DAILY_CAP,
    });
    if (job.hirerProfile) {
        const hirer = await HirerProfile_1.HirerProfile.findById(job.hirerProfile).select('user').lean();
        if (hirer?.user) {
            try {
                await (0, notify_service_1.notifyUser)({
                    user: hirer.user,
                    role: 'hirer',
                    type: 'new_applicant',
                    title: 'New applicant',
                    body: `${user.profile.fullName} applied to "${job.title}"`,
                    data: {
                        applicationId: applied._id.toString(),
                        jobId: job._id.toString(),
                        matchScore: score,
                    },
                });
                (0, socket_1.emitToUser)(hirer.user.toString(), 'applicant:new', {
                    applicationId: applied._id.toString(),
                    jobId: job._id.toString(),
                    matchScore: score,
                });
            }
            catch {
            }
        }
    }
    res.status(201).json({
        success: true,
        message: 'Application sent',
        data: applied,
        coinsAwarded: coinGrant.amount,
        coinsBalance: coinGrant.balance,
    });
});
exports.listApplied = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const typeFilter = typeof req.query.type === 'string' ? req.query.type : undefined;
    const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20);
    const skip = (page - 1) * limit;
    const cutoff = new Date(Date.now() - jobScraper_cron_1.APPLIED_JOB_VIEW_DAYS * 24 * 60 * 60 * 1000);
    const filter = {
        user: req.user._id,
        appliedAt: { $gte: cutoff },
    };
    if (status)
        filter.status = status;
    if (typeFilter === 'native') {
        filter.applyType = { $in: ['one_click', 'custom_form', 'auto_apply'] };
    }
    else if (typeFilter === 'external') {
        filter.applyType = 'external_manual';
    }
    const [items, total] = await Promise.all([
        AppliedJob_1.AppliedJob.find(filter).sort({ appliedAt: -1 }).skip(skip).limit(limit).populate('job'),
        AppliedJob_1.AppliedJob.countDocuments(filter),
    ]);
    res.json({
        success: true,
        data: items,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
});
exports.updateApplied = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { id } = req.params;
    const updated = await AppliedJob_1.AppliedJob.findOneAndUpdate({ _id: id, user: req.user._id }, { $set: req.body }, { new: true, runValidators: true });
    if (!updated)
        throw ApiError_1.ApiError.notFound('Applied job not found');
    res.json({ success: true, data: updated });
});
exports.deleteApplied = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { id } = req.params;
    const deleted = await AppliedJob_1.AppliedJob.findOneAndDelete({ _id: id, user: req.user._id });
    if (!deleted)
        throw ApiError_1.ApiError.notFound('Applied job not found');
    res.json({ success: true, message: 'Removed' });
});
exports.appliedStats = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const stats = await AppliedJob_1.AppliedJob.aggregate([
        { $match: { user: req.user._id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const total = await AppliedJob_1.AppliedJob.countDocuments({ user: req.user._id });
    res.json({ success: true, data: { total, byStatus: stats } });
});
