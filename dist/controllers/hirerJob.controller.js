"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJobAnalytics = exports.deleteJob = exports.updateJobStatus = exports.updateJob = exports.getMyJob = exports.listMyJobs = exports.createJob = exports.updateStatusSchema = exports.listMyJobsSchema = exports.updateJobSchema = exports.createJobSchema = void 0;
const zod_1 = require("zod");
const Job_1 = require("../models/Job");
const HirerProfile_1 = require("../models/HirerProfile");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
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
