"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateHirerNotes = exports.getJobKanban = exports.bulkUpdateApplicants = exports.updateApplicantStatus = exports.getApplicantDetail = exports.listAllApplicants = exports.listJobApplicants = exports.updateHirerNotesSchema = exports.bulkUpdateApplicantsSchema = exports.updateApplicantStatusSchema = exports.listApplicantsSchema = void 0;
const zod_1 = require("zod");
const mongoose_1 = __importDefault(require("mongoose"));
const AppliedJob_1 = require("../models/AppliedJob");
const Job_1 = require("../models/Job");
const HirerProfile_1 = require("../models/HirerProfile");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const notify_service_1 = require("../services/notification/notify.service");
const socket_1 = require("../services/chat/socket");
const HIRER_STATUSES = [
    'applied',
    'viewed',
    'shortlisted',
    'interview',
    'offer',
    'hired',
    'rejected',
];
exports.listApplicantsSchema = zod_1.z.object({
    query: zod_1.z.object({
        status: zod_1.z
            .enum(['all', ...HIRER_STATUSES])
            .default('all'),
        minMatch: zod_1.z.coerce.number().min(0).max(100).optional(),
        skill: zod_1.z.string().max(100).optional(),
        page: zod_1.z.coerce.number().int().min(1).default(1),
        limit: zod_1.z.coerce.number().int().min(1).max(100).default(20),
        sort: zod_1.z.enum(['recent', 'match', 'name']).default('recent'),
    }),
});
exports.updateApplicantStatusSchema = zod_1.z.object({
    body: zod_1.z.object({
        status: zod_1.z.enum(HIRER_STATUSES),
        note: zod_1.z.string().max(1000).optional(),
        rejectionReason: zod_1.z.string().max(1000).optional(),
    }),
});
exports.bulkUpdateApplicantsSchema = zod_1.z.object({
    body: zod_1.z.object({
        applicationIds: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(200),
        status: zod_1.z.enum(HIRER_STATUSES),
        note: zod_1.z.string().max(1000).optional(),
    }),
});
exports.updateHirerNotesSchema = zod_1.z.object({
    body: zod_1.z.object({
        hirerNotes: zod_1.z.string().max(4000),
    }),
});
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
const requireHirerProfile = async (userId) => {
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: userId });
    if (!profile)
        throw ApiError_1.ApiError.forbidden('Set up a company profile first');
    return profile;
};
const requireOwnedJob = async (jobId, hirerProfileId) => {
    if (!isObjectId(jobId))
        throw ApiError_1.ApiError.badRequest('Invalid job id');
    const job = await Job_1.Job.findById(jobId);
    if (!job || !job.isNative)
        throw ApiError_1.ApiError.notFound('Job not found');
    if (!job.hirerProfile || job.hirerProfile.toString() !== hirerProfileId.toString()) {
        throw ApiError_1.ApiError.forbidden('You do not have access to this job');
    }
    return job;
};
const sanitiseSeeker = (u) => ({
    id: u._id.toString(),
    email: u.email,
    fullName: u.profile.fullName,
    avatar: u.profile.avatar,
    headline: u.profile.headline,
    phone: u.profile.phone,
    skills: u.profile.skills,
    experienceYears: u.profile.experienceYears,
    preferredLocations: u.profile.preferredLocations,
    resumeUrl: u.profile.resumeUrl,
});
const buildApplicantPayload = (a, seeker) => ({
    applicationId: a._id.toString(),
    jobId: a.job.toString(),
    status: a.status,
    matchScore: a.matchScore,
    appliedAt: a.appliedAt,
    applyType: a.applyType,
    source: a.source,
    quickNote: a.quickNote,
    resumeUrlSnapshot: a.resumeUrlSnapshot,
    screeningAnswers: a.screeningAnswers,
    hirerNotes: a.hirerNotes,
    rejectionReason: a.rejectionReason,
    statusHistory: a.statusHistory,
    jobSnapshot: a.jobSnapshot,
    seeker,
});
const recomputeShortlistedCount = async (jobId) => {
    const c = await AppliedJob_1.AppliedJob.countDocuments({
        job: jobId,
        status: { $in: ['shortlisted', 'interview', 'offer', 'hired'] },
    });
    await Job_1.Job.updateOne({ _id: jobId }, { $set: { shortlistedCount: c } });
};
exports.listJobApplicants = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const job = await requireOwnedJob(String(req.params.jobId), profile._id);
    const q = req.query;
    const filter = { job: job._id };
    if (q.status !== 'all')
        filter.status = q.status;
    if (q.minMatch !== undefined)
        filter.matchScore = { $gte: q.minMatch };
    const skip = (q.page - 1) * q.limit;
    const sort = q.sort === 'match' ? { matchScore: -1, appliedAt: -1 } : { appliedAt: -1 };
    const [items, total] = await Promise.all([
        AppliedJob_1.AppliedJob.find(filter)
            .sort(sort)
            .skip(skip)
            .limit(q.limit)
            .populate({
            path: 'user',
            select: 'email profile.fullName profile.avatar profile.headline profile.phone profile.skills profile.experienceYears profile.preferredLocations profile.resumeUrl',
        }),
        AppliedJob_1.AppliedJob.countDocuments(filter),
    ]);
    let payloads = items.map((a) => {
        const u = a.user;
        return buildApplicantPayload(a, u ? sanitiseSeeker(u) : null);
    });
    if (q.skill) {
        const needle = q.skill.toLowerCase();
        payloads = payloads.filter((p) => p.seeker?.skills?.some((s) => s.toLowerCase().includes(needle)));
    }
    if (q.sort === 'name') {
        payloads.sort((a, b) => (a.seeker?.fullName ?? '').localeCompare(b.seeker?.fullName ?? ''));
    }
    res.json({
        success: true,
        data: payloads,
        meta: {
            page: q.page,
            limit: q.limit,
            total,
            totalPages: Math.ceil(total / q.limit) || 1,
            jobTitle: job.title,
        },
    });
});
exports.listAllApplicants = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const q = req.query;
    const filter = { hirerProfile: profile._id };
    if (q.status !== 'all')
        filter.status = q.status;
    if (q.minMatch !== undefined)
        filter.matchScore = { $gte: q.minMatch };
    const skip = (q.page - 1) * q.limit;
    const sort = q.sort === 'match' ? { matchScore: -1, appliedAt: -1 } : { appliedAt: -1 };
    const [items, total] = await Promise.all([
        AppliedJob_1.AppliedJob.find(filter)
            .sort(sort)
            .skip(skip)
            .limit(q.limit)
            .populate({
            path: 'user',
            select: 'email profile.fullName profile.avatar profile.headline profile.phone profile.skills profile.experienceYears profile.preferredLocations profile.resumeUrl',
        }),
        AppliedJob_1.AppliedJob.countDocuments(filter),
    ]);
    const payloads = items.map((a) => {
        const u = a.user;
        return buildApplicantPayload(a, u ? sanitiseSeeker(u) : null);
    });
    res.json({
        success: true,
        data: payloads,
        meta: {
            page: q.page,
            limit: q.limit,
            total,
            totalPages: Math.ceil(total / q.limit) || 1,
        },
    });
});
exports.getApplicantDetail = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid application id');
    const application = await AppliedJob_1.AppliedJob.findById(id).populate({
        path: 'user',
        select: 'email profile',
    });
    if (!application)
        throw ApiError_1.ApiError.notFound('Application not found');
    await requireOwnedJob(application.job.toString(), profile._id);
    if (application.status === 'applied') {
        application.status = 'viewed';
        application.statusHistory.push({
            status: 'viewed',
            changedAt: new Date(),
            changedBy: new mongoose_1.default.Types.ObjectId(req.user._id.toString()),
        });
        await application.save();
    }
    const u = application.user;
    res.json({
        success: true,
        data: {
            ...buildApplicantPayload(application, u
                ? {
                    id: u._id.toString(),
                    email: u.email,
                    fullName: u.profile.fullName,
                    avatar: u.profile.avatar,
                    headline: u.profile.headline,
                    phone: u.profile.phone,
                    skills: u.profile.skills,
                    experienceYears: u.profile.experienceYears,
                    preferredLocations: u.profile.preferredLocations,
                    resumeUrl: u.profile.resumeUrl,
                }
                : null),
            seekerProfile: u
                ? {
                    ...u.profile,
                }
                : null,
        },
    });
});
const TERMINAL = ['hired', 'rejected', 'withdrawn'];
exports.updateApplicantStatus = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid application id');
    const application = await AppliedJob_1.AppliedJob.findById(id);
    if (!application)
        throw ApiError_1.ApiError.notFound('Application not found');
    await requireOwnedJob(application.job.toString(), profile._id);
    const { status, note, rejectionReason } = req.body;
    if (TERMINAL.includes(application.status)) {
        throw ApiError_1.ApiError.badRequest(`Application is in terminal state (${application.status}); cannot update`);
    }
    application.status = status;
    application.statusHistory.push({
        status,
        changedAt: new Date(),
        changedBy: new mongoose_1.default.Types.ObjectId(req.user._id.toString()),
        note,
    });
    if (status === 'rejected' && rejectionReason) {
        application.rejectionReason = rejectionReason;
    }
    await application.save();
    await recomputeShortlistedCount(application.job);
    await (0, notify_service_1.notifyUser)({
        user: application.user,
        role: 'seeker',
        type: 'application_status',
        title: 'Application status updated',
        body: `Your application for "${application.jobSnapshot.title}" is now ${status}.`,
        data: {
            applicationId: application._id.toString(),
            jobId: application.job.toString(),
            status,
        },
    });
    (0, socket_1.emitToUser)(application.user.toString(), 'application:status', {
        applicationId: application._id.toString(),
        jobId: application.job.toString(),
        status,
    });
    res.json({
        success: true,
        data: { id: application._id.toString(), status: application.status },
    });
});
exports.bulkUpdateApplicants = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const { applicationIds, status, note } = req.body;
    const ids = applicationIds.filter(isObjectId);
    if (ids.length === 0)
        throw ApiError_1.ApiError.badRequest('No valid application ids');
    const ownedJobIds = (await Job_1.Job.find({ hirerProfile: profile._id, isNative: true }).select('_id').lean()).map((j) => j._id);
    const result = await AppliedJob_1.AppliedJob.updateMany({
        _id: { $in: ids },
        job: { $in: ownedJobIds },
        status: { $nin: TERMINAL },
    }, {
        $set: { status },
        $push: {
            statusHistory: {
                status,
                changedAt: new Date(),
                changedBy: req.user._id,
                note,
            },
        },
    });
    for (const jobId of ownedJobIds) {
        await recomputeShortlistedCount(jobId);
    }
    res.json({
        success: true,
        data: {
            matched: result.matchedCount,
            modified: result.modifiedCount,
        },
    });
});
exports.getJobKanban = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const job = await requireOwnedJob(String(req.params.jobId), profile._id);
    const items = await AppliedJob_1.AppliedJob.find({ job: job._id })
        .sort({ matchScore: -1, appliedAt: -1 })
        .populate({
        path: 'user',
        select: 'email profile.fullName profile.avatar profile.headline profile.skills profile.experienceYears profile.preferredLocations profile.resumeUrl profile.phone',
    })
        .lean();
    const columns = {
        applied: [],
        shortlisted: [],
        interview: [],
        offer: [],
        hired: [],
        rejected: [],
        withdrawn: [],
    };
    for (const a of items) {
        const col = columns[a.status];
        if (!col)
            continue;
        const u = a.user;
        col.push(buildApplicantPayload(a, u ? sanitiseSeeker(u) : null));
    }
    res.json({
        success: true,
        data: {
            jobId: job._id.toString(),
            jobTitle: job.title,
            columns,
        },
    });
});
exports.updateHirerNotes = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid application id');
    const application = await AppliedJob_1.AppliedJob.findById(id);
    if (!application)
        throw ApiError_1.ApiError.notFound('Application not found');
    await requireOwnedJob(application.job.toString(), profile._id);
    const { hirerNotes } = req.body;
    application.hirerNotes = hirerNotes;
    await application.save();
    res.json({ success: true, data: { id: application._id.toString() } });
});
