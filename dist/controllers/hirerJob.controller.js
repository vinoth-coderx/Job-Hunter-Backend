"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.polishJdEndpoint = exports.polishJdSchema = exports.generateScreeningQuestionsEndpoint = exports.generateScreeningQuestionsSchema = exports.submitModerationAppeal = exports.submitModerationAppealSchema = exports.extractSkillsEndpoint = exports.extractSkillsSchema = exports.generateJdEndpoint = exports.generateJdSchema = exports.getJobAnalytics = exports.deleteJob = exports.updateJobStatus = exports.updateJob = exports.getMyJob = exports.listMyJobs = exports.createJob = exports.updateStatusSchema = exports.listMyJobsSchema = exports.updateJobSchema = exports.createJobSchema = void 0;
const zod_1 = require("zod");
const mongoose_1 = __importDefault(require("mongoose"));
const Job_1 = require("../models/Job");
const HirerProfile_1 = require("../models/HirerProfile");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const jdGenerator_service_1 = require("../services/ai/jdGenerator.service");
const skillExtractor_service_1 = require("../services/ai/skillExtractor.service");
const screeningQuestions_service_1 = require("../services/ai/screeningQuestions.service");
const jdPolish_service_1 = require("../services/ai/jdPolish.service");
const quota_service_1 = require("../services/ai/quota.service");
const aiCreditWeights_1 = require("../config/aiCreditWeights");
const JobModeration_1 = require("../models/JobModeration");
const audit_service_1 = require("../services/security/audit.service");
const screeningQuestionSchema = zod_1.z.object({
    question: zod_1.z.string().min(3).max(500),
    type: zod_1.z.enum(['text', 'mcq', 'yes_no']),
    options: zod_1.z.array(zod_1.z.string().min(1).max(200)).max(10).optional(),
    isRequired: zod_1.z.boolean().default(false),
});
const baseJobBody = {
    title: zod_1.z.string().min(2).max(200),
    department: zod_1.z.string().max(100).optional(),
    description: zod_1.z.string().min(20).max(20000),
    responsibilities: zod_1.z.array(zod_1.z.string().min(1).max(500)).max(20).optional(),
    location: zod_1.z.string().min(2).max(200),
    jobType: zod_1.z.enum(['full-time', 'part-time', 'contract', 'internship', 'temporary']),
    remoteType: zod_1.z.enum(['remote', 'hybrid', 'onsite']),
    openingsCount: zod_1.z.coerce.number().int().min(1).max(1000).default(1),
    experienceMinYears: zod_1.z.coerce.number().min(0).max(60).optional(),
    experienceMaxYears: zod_1.z.coerce.number().min(0).max(60).optional(),
    education: zod_1.z.string().max(200).optional(),
    skills: zod_1.z.array(zod_1.z.string().min(1).max(100)).min(1).max(40),
    niceToHaveSkills: zod_1.z.array(zod_1.z.string().min(1).max(100)).max(40).optional(),
    isSalaryVisible: zod_1.z.boolean().default(true),
    salaryMin: zod_1.z.coerce.number().min(0).optional(),
    salaryMax: zod_1.z.coerce.number().min(0).optional(),
    currency: zod_1.z.string().max(8).default('INR'),
    perks: zod_1.z.array(zod_1.z.string().min(1).max(100)).max(30).optional(),
    applyType: zod_1.z.enum(['easy_apply', 'custom_form']).default('easy_apply'),
    requiredDocuments: zod_1.z.array(zod_1.z.string().min(1).max(50)).max(10).optional(),
    screeningQuestions: zod_1.z.array(screeningQuestionSchema).max(5).optional(),
    applicationDeadline: zod_1.z.coerce.date().optional(),
};
exports.createJobSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        ...baseJobBody,
        saveAsDraft: zod_1.z.boolean().default(false),
    })
        .refine((b) => b.salaryMin === undefined || b.salaryMax === undefined || b.salaryMax >= b.salaryMin, {
        message: 'salaryMax must be >= salaryMin',
        path: ['salaryMax'],
    })
        .refine((b) => b.experienceMinYears === undefined || b.experienceMaxYears === undefined || b.experienceMaxYears >= b.experienceMinYears, {
        message: 'experienceMaxYears must be >= experienceMinYears',
        path: ['experienceMaxYears'],
    }),
});
exports.updateJobSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        ...Object.fromEntries(Object.entries(baseJobBody).map(([k, v]) => [k, v.optional()])),
    })
        .passthrough(),
});
exports.listMyJobsSchema = zod_1.z.object({
    query: zod_1.z.object({
        status: zod_1.z.enum(['draft', 'active', 'paused', 'closed', 'expired', 'all']).default('all'),
        page: zod_1.z.coerce.number().int().min(1).default(1),
        limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
    }),
});
exports.updateStatusSchema = zod_1.z.object({
    body: zod_1.z.object({
        status: zod_1.z.enum(['draft', 'active', 'paused', 'closed']),
    }),
});
const requireHirerProfile = async (userId) => {
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: userId });
    if (!profile) {
        throw ApiError_1.ApiError.forbidden('Set up a company profile before posting jobs');
    }
    return profile;
};
const assertOwnership = (job, profileId) => {
    if (!job.hirerProfile || job.hirerProfile.toString() !== profileId.toString()) {
        throw ApiError_1.ApiError.forbidden('You do not have access to this job');
    }
};
const isValidObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
exports.createJob = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    if (profile.approvalStatus === 'suspended' || profile.approvalStatus === 'banned') {
        throw new ApiError_1.ApiError(403, profile.approvalStatus === 'banned'
            ? 'Your hirer account is banned. Contact support.'
            : 'Your hirer account is suspended. Resolve open reports before posting.');
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todaysCount = await Job_1.Job.countDocuments({
        postedBy: req.user._id,
        isNative: true,
        createdAt: { $gte: today },
    });
    if (todaysCount >= profile.dailyPostLimit) {
        throw new ApiError_1.ApiError(429, `Daily posting limit reached (${profile.dailyPostLimit}). Build trust by verifying your company to unlock more.`);
    }
    const body = req.body;
    const status = body.saveAsDraft ? 'draft' : 'active';
    const now = new Date();
    const job = await Job_1.Job.create({
        isNative: true,
        source: 'native',
        hirerProfile: profile._id,
        postedBy: req.user._id,
        title: body.title,
        company: profile.companyName,
        companyLogoUrl: profile.companyLogoUrl,
        department: body.department,
        description: body.description,
        responsibilities: body.responsibilities,
        location: body.location,
        url: `app://jobs/native`,
        salaryMin: body.salaryMin,
        salaryMax: body.salaryMax,
        currency: body.currency,
        isSalaryVisible: body.isSalaryVisible,
        perks: body.perks,
        jobType: body.jobType,
        remoteType: body.remoteType,
        openingsCount: body.openingsCount,
        experienceMinYears: body.experienceMinYears,
        experienceMaxYears: body.experienceMaxYears,
        education: body.education,
        skills: body.skills.map((s) => s.toLowerCase().trim()),
        niceToHaveSkills: body.niceToHaveSkills?.map((s) => s.toLowerCase().trim()),
        applyType: body.applyType,
        requiredDocuments: body.requiredDocuments,
        screeningQuestions: body.screeningQuestions,
        applicationDeadline: body.applicationDeadline,
        status,
        publishedAt: status === 'active' ? now : undefined,
        postedAt: now,
        fetchedAt: now,
        isActive: status === 'active',
    });
    if (status === 'active') {
        const { moderateJob } = await Promise.resolve().then(() => __importStar(require('../services/security/moderation.service')));
        const result = await moderateJob(job);
        job.moderation.status =
            result.decision === 'auto_rejected' ? 'rejected' : result.decision;
        job.moderation.riskScore = result.riskScore;
        job.moderation.flags = result.flags;
        job.moderation.contentHash = result.contentHash;
        job.moderation.lastModelRun = new Date();
        if (result.duplicateOf) {
            job.moderation.duplicateOf = new mongoose_1.default.Types.ObjectId(result.duplicateOf);
        }
        job.isPublic = result.decision === 'auto_approved';
        if (result.decision === 'auto_rejected') {
            job.status = 'closed';
            job.isActive = false;
        }
        await job.save();
    }
    res.status(201).json({ success: true, data: job });
});
exports.listMyJobs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const q = req.query;
    const filter = {
        hirerProfile: profile._id,
        isNative: true,
    };
    if (q.status !== 'all')
        filter.status = q.status;
    const skip = (q.page - 1) * q.limit;
    const [items, total] = await Promise.all([
        Job_1.Job.find(filter).sort({ createdAt: -1 }).skip(skip).limit(q.limit).lean(),
        Job_1.Job.countDocuments(filter),
    ]);
    res.json({
        success: true,
        data: items,
        meta: {
            page: q.page,
            limit: q.limit,
            total,
            totalPages: Math.ceil(total / q.limit) || 1,
        },
    });
});
exports.getMyJob = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isValidObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid job id');
    const job = await Job_1.Job.findById(id);
    if (!job || !job.isNative)
        throw ApiError_1.ApiError.notFound('Job not found');
    assertOwnership(job, profile._id);
    res.json({ success: true, data: job });
});
exports.updateJob = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isValidObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid job id');
    const job = await Job_1.Job.findById(id);
    if (!job || !job.isNative)
        throw ApiError_1.ApiError.notFound('Job not found');
    assertOwnership(job, profile._id);
    if (job.status === 'closed' || job.status === 'expired') {
        throw ApiError_1.ApiError.badRequest('Cannot edit a closed job; create a new one instead');
    }
    const body = req.body;
    const updatable = [
        'title',
        'department',
        'description',
        'responsibilities',
        'location',
        'jobType',
        'remoteType',
        'openingsCount',
        'experienceMinYears',
        'experienceMaxYears',
        'education',
        'skills',
        'niceToHaveSkills',
        'isSalaryVisible',
        'salaryMin',
        'salaryMax',
        'currency',
        'perks',
        'applyType',
        'requiredDocuments',
        'screeningQuestions',
        'applicationDeadline',
    ];
    for (const key of updatable) {
        if (body[key] !== undefined) {
            if ((key === 'skills' || key === 'niceToHaveSkills') && Array.isArray(body[key])) {
                job[key] = body[key].map((s) => s.toLowerCase().trim());
            }
            else {
                job[key] = body[key];
            }
        }
    }
    await job.save();
    res.json({ success: true, data: job });
});
exports.updateJobStatus = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isValidObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid job id');
    const job = await Job_1.Job.findById(id);
    if (!job || !job.isNative)
        throw ApiError_1.ApiError.notFound('Job not found');
    assertOwnership(job, profile._id);
    const { status } = req.body;
    const legal = {
        draft: ['active', 'closed'],
        active: ['paused', 'closed'],
        paused: ['active', 'closed'],
        closed: [],
        expired: [],
    };
    if (!legal[job.status].includes(status)) {
        throw ApiError_1.ApiError.badRequest(`Cannot move job from ${job.status} → ${status}`);
    }
    job.status = status;
    job.isActive = status === 'active';
    if (status === 'active' && !job.publishedAt)
        job.publishedAt = new Date();
    if (status === 'closed')
        job.closedAt = new Date();
    await job.save();
    res.json({ success: true, data: { id: job._id, status: job.status } });
});
exports.deleteJob = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isValidObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid job id');
    const job = await Job_1.Job.findById(id);
    if (!job || !job.isNative)
        throw ApiError_1.ApiError.notFound('Job not found');
    assertOwnership(job, profile._id);
    if (job.status !== 'draft') {
        throw ApiError_1.ApiError.badRequest('Only draft jobs can be deleted; close published jobs instead');
    }
    await job.deleteOne();
    res.json({ success: true, message: 'Draft deleted' });
});
exports.getJobAnalytics = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isValidObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid job id');
    const job = await Job_1.Job.findById(id).lean();
    if (!job || !job.isNative)
        throw ApiError_1.ApiError.notFound('Job not found');
    if (!job.hirerProfile || job.hirerProfile.toString() !== profile._id.toString()) {
        throw ApiError_1.ApiError.forbidden('You do not have access to this job');
    }
    res.json({
        success: true,
        data: {
            jobId: job._id,
            title: job.title,
            status: job.status,
            viewsCount: job.viewsCount,
            applicationsCount: job.applicationsCount,
            shortlistedCount: job.shortlistedCount,
            shortlistRate: job.applicationsCount > 0
                ? Math.round((job.shortlistedCount / job.applicationsCount) * 100)
                : 0,
            publishedAt: job.publishedAt,
            applicationDeadline: job.applicationDeadline,
            isBoosted: job.isBoosted,
        },
    });
});
exports.generateJdSchema = zod_1.z.object({
    body: zod_1.z.object({
        role: zod_1.z.string().min(2).max(120),
        experienceMinYears: zod_1.z.coerce.number().min(0).max(60).optional(),
        experienceMaxYears: zod_1.z.coerce.number().min(0).max(60).optional(),
        location: zod_1.z.string().max(120).optional(),
        remoteType: zod_1.z.enum(['onsite', 'hybrid', 'remote']).optional(),
        jobType: zod_1.z.string().max(40).optional(),
        keywords: zod_1.z.array(zod_1.z.string().min(1).max(40)).max(8).optional(),
        toneHint: zod_1.z.enum(['professional', 'casual', 'startup']).optional(),
    }),
});
exports.generateJdEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: userId }).select('companyName');
    if (!profile)
        throw ApiError_1.ApiError.forbidden('Hirer profile required to generate JD');
    const body = req.body;
    const weight = (0, aiCreditWeights_1.getCreditWeight)('jd_generator');
    const quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let jd;
    try {
        jd = await (0, jdGenerator_service_1.generateJd)({ ...body, companyName: profile.companyName });
    }
    catch (err) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!jd) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        res.json({ success: true, data: null, message: 'AI unavailable', quota });
        return;
    }
    res.json({ success: true, data: jd, quota });
});
exports.extractSkillsSchema = zod_1.z.object({
    body: zod_1.z.object({
        text: zod_1.z.string().min(30).max(8000),
    }),
});
exports.extractSkillsEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    await requireHirerProfile(req.user.id);
    const { text } = req.body;
    const result = await (0, skillExtractor_service_1.extractSkills)(text, { userId: String(req.user._id) });
    res.json({ success: true, data: result });
});
exports.submitModerationAppealSchema = zod_1.z.object({
    body: zod_1.z.object({
        reason: zod_1.z.string().min(20).max(2000),
    }),
});
exports.submitModerationAppeal = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isValidObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid job id');
    const job = await Job_1.Job.findById(id);
    if (!job || !job.isNative)
        throw ApiError_1.ApiError.notFound('Job not found');
    assertOwnership(job, profile._id);
    const moderation = await JobModeration_1.JobModeration.findOne({ job: job._id }).sort({
        createdAt: -1,
    });
    if (!moderation) {
        throw ApiError_1.ApiError.badRequest('No moderation record exists for this job');
    }
    const isRejected = moderation.decision === 'auto_rejected' ||
        moderation.overrideDecision === 'rejected';
    if (!isRejected) {
        throw ApiError_1.ApiError.badRequest('Only rejected jobs can be appealed');
    }
    if (moderation.appeal && moderation.appeal.status === 'pending') {
        throw ApiError_1.ApiError.badRequest('An appeal is already pending review for this job');
    }
    const { reason } = req.body;
    const userId = req.user._id;
    const submittedAt = new Date();
    moderation.appeal = {
        submittedBy: userId,
        reason,
        submittedAt,
        status: 'pending',
    };
    await moderation.save();
    await (0, audit_service_1.writeAudit)({
        actor: { id: userId, email: req.user.email },
        actorType: 'hirer',
        category: 'job_moderation',
        action: 'moderation:appeal_submitted',
        target: { type: 'Job', id: job._id, label: job.title },
        metadata: { reason: reason.slice(0, 200) },
        req,
    });
    res.json({
        success: true,
        data: {
            jobId: job._id.toString(),
            appealStatus: 'pending',
            submittedAt,
        },
    });
});
exports.generateScreeningQuestionsSchema = zod_1.z.object({
    body: zod_1.z.object({
        title: zod_1.z.string().min(3).max(200),
        description: zod_1.z.string().min(20).max(20000),
        skills: zod_1.z.array(zod_1.z.string().min(1).max(100)).max(40).default([]),
    }),
});
exports.generateScreeningQuestionsEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const { title, description, skills } = req.body;
    const cached = await (0, screeningQuestions_service_1.peekCachedScreeningQuestions)(title, description, skills);
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (cached) {
        res.json({
            success: true,
            data: { questions: cached, usedAi: true, cached: true },
            quota,
        });
        return;
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)('screening_questions');
    if (weight > 0)
        quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, screeningQuestions_service_1.generateScreeningQuestions)({
            title,
            description,
            skills,
            userId,
        });
    }
    catch (err) {
        if (weight > 0)
            await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (weight > 0 && !result.usedAi) {
        await (0, quota_service_1.refundQuota)(userId, weight);
    }
    res.json({
        success: true,
        data: result,
        quota,
    });
});
exports.polishJdSchema = zod_1.z.object({
    body: zod_1.z.object({
        title: zod_1.z.string().min(3).max(200),
        description: zod_1.z.string().min(50).max(20000),
    }),
});
exports.polishJdEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const { title, description } = req.body;
    const cached = await (0, jdPolish_service_1.peekCachedPolishedJd)(title, description);
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (cached) {
        res.json({ success: true, data: cached, quota });
        return;
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)('jd_polish');
    if (weight > 0)
        quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, jdPolish_service_1.polishJd)({ title, description, userId });
    }
    catch (err) {
        if (weight > 0)
            await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (weight > 0 && !result.usedAi) {
        await (0, quota_service_1.refundQuota)(userId, weight);
    }
    res.json({ success: true, data: result, quota });
});
