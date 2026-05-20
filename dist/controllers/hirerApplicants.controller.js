"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getApplicantResumeTldr = exports.draftCandidateOutreach = exports.suggestJobCandidates = exports.rankJobApplicants = exports.updateHirerNotes = exports.getJobKanban = exports.bulkUpdateApplicants = exports.updateApplicantStatus = exports.downloadApplicantResume = exports.getApplicantDetail = exports.listAllApplicants = exports.listJobApplicants = exports.candidateSuggestionsSchema = exports.rankApplicantsSchema = exports.updateHirerNotesSchema = exports.bulkUpdateApplicantsSchema = exports.updateApplicantStatusSchema = exports.listApplicantsSchema = void 0;
const zod_1 = require("zod");
const mongoose_1 = __importDefault(require("mongoose"));
const AppliedJob_1 = require("../models/AppliedJob");
const Job_1 = require("../models/Job");
const HirerProfile_1 = require("../models/HirerProfile");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const notify_service_1 = require("../services/notification/notify.service");
const socket_1 = require("../services/chat/socket");
const ResumeAccessLog_1 = require("../models/ResumeAccessLog");
const User_1 = require("../models/User");
const cloudinary_1 = require("../config/cloudinary");
const aiCreditWeights_1 = require("../config/aiCreditWeights");
const applicantRanker_service_1 = require("../services/ai/applicantRanker.service");
const candidateSuggester_service_1 = require("../services/ai/candidateSuggester.service");
const recruiterOutreach_service_1 = require("../services/ai/recruiterOutreach.service");
const resumeTldr_service_1 = require("../services/ai/resumeTldr.service");
const quota_service_1 = require("../services/ai/quota.service");
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
exports.rankApplicantsSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        limit: zod_1.z.coerce.number().int().min(1).max(25).optional(),
    })
        .partial(),
});
exports.candidateSuggestionsSchema = zod_1.z.object({
    body: zod_1.z
        .object({
        limit: zod_1.z.coerce.number().int().min(1).max(20).optional(),
        poolSize: zod_1.z.coerce.number().int().min(1).max(50).optional(),
    })
        .partial(),
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
    aiRanking: a.aiRanking
        ? {
            score: a.aiRanking.score,
            rank: a.aiRanking.rank,
            summary: a.aiRanking.summary,
            strengths: a.aiRanking.strengths,
            concerns: a.aiRanking.concerns,
            rankedAt: a.aiRanking.rankedAt,
        }
        : undefined,
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
    const seekerDoc = u
        ? await User_1.User.findById(u._id).select('privacy')
        : null;
    const privacy = seekerDoc?.privacy;
    const showContact = !privacy?.hideContactUntilShortlisted ||
        ['shortlisted', 'interview', 'offer', 'hired'].includes(application.status);
    if (u && u.profile.resumeUrl) {
        ResumeAccessLog_1.ResumeAccessLog.create({
            resumeOwner: u._id,
            accessor: req.user._id,
            accessorRole: 'hirer',
            company: profile.companyName,
            action: 'view',
            application: application._id,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
        }).catch(() => undefined);
    }
    res.json({
        success: true,
        data: {
            ...buildApplicantPayload(application, u
                ? {
                    id: u._id.toString(),
                    email: showContact ? u.email : 'hidden until shortlisted',
                    fullName: u.profile.fullName,
                    avatar: u.profile.avatar,
                    headline: u.profile.headline,
                    phone: showContact ? u.profile.phone : undefined,
                    skills: u.profile.skills,
                    experienceYears: u.profile.experienceYears,
                    preferredLocations: u.profile.preferredLocations,
                    resumeUrl: u.profile.resumeUrl,
                }
                : null),
            seekerProfile: u
                ? {
                    ...u.profile,
                    phone: showContact ? u.profile.phone : undefined,
                }
                : null,
            seekerPrivacy: {
                hideContactUntilShortlisted: privacy?.hideContactUntilShortlisted ?? false,
                allowResumeDownload: privacy?.allowResumeDownload ?? true,
                contactRevealed: showContact,
            },
        },
    });
});
const formatFromMime = (mime) => {
    if (mime === 'application/pdf')
        return 'pdf';
    if (mime === 'application/msword')
        return 'doc';
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        return 'docx';
    }
    return 'bin';
};
exports.downloadApplicantResume = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
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
    const seeker = await User_1.User.findById(application.user).select('privacy profile.resumeFile profile.resumeUrl');
    if (!seeker?.profile?.resumeFile?.publicId) {
        throw ApiError_1.ApiError.notFound('Applicant has no resume on file');
    }
    if (seeker.privacy?.allowResumeDownload === false) {
        throw ApiError_1.ApiError.forbidden('Applicant has disabled resume downloads. View only.');
    }
    const file = seeker.profile.resumeFile;
    const signed = (0, cloudinary_1.signedDeliveryUrl)(file.publicId, {
        resourceType: 'raw',
        type: 'authenticated',
        format: formatFromMime(file.mimeType),
        expiresInSec: 300,
        attachmentFilename: file.originalName,
    });
    await ResumeAccessLog_1.ResumeAccessLog.create({
        resumeOwner: seeker._id,
        accessor: req.user._id,
        accessorRole: 'hirer',
        company: profile.companyName,
        action: 'download',
        application: application._id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
    });
    res.redirect(302, signed);
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
exports.rankJobApplicants = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const profile = await requireHirerProfile(req.user.id);
    const job = await requireOwnedJob(String(req.params.jobId), profile._id);
    const { limit } = req.body;
    const cap = Math.max(1, Math.min(25, limit ?? 25));
    const apps = await AppliedJob_1.AppliedJob.find({ job: job._id })
        .sort({ appliedAt: -1 })
        .limit(cap)
        .populate({
        path: 'user',
        select: 'profile.fullName profile.headline profile.experienceYears profile.skills profile.resumeText',
    });
    if (apps.length === 0) {
        const quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
        res.json({
            success: true,
            data: { rankings: [], usedAi: false, cached: false },
            quota,
        });
        return;
    }
    const rankable = apps.map((a) => {
        const u = a.user;
        return {
            applicationId: a._id.toString(),
            fullName: u?.profile?.fullName ?? 'Candidate',
            headline: u?.profile?.headline,
            experienceYears: u?.profile?.experienceYears,
            skills: u?.profile?.skills ?? [],
            resumeText: u?.profile?.resumeText,
            heuristicMatch: a.matchScore,
        };
    });
    const ids = rankable.map((r) => r.applicationId);
    const cached = await (0, applicantRanker_service_1.peekCachedRanking)(job._id.toString(), job.updatedAt, ids);
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (cached) {
        res.json({
            success: true,
            data: { rankings: cached, usedAi: true, cached: true },
            quota,
        });
        return;
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)('applicant_rank');
    quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, applicantRanker_service_1.rankApplicants)({ job, applicants: rankable, userId });
    }
    catch (err) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!result.usedAi)
        await (0, quota_service_1.refundQuota)(userId, weight);
    if (result.rankings.length > 0) {
        const now = new Date();
        const ops = result.rankings.map((r) => ({
            updateOne: {
                filter: { _id: r.applicationId },
                update: {
                    $set: {
                        aiRanking: {
                            score: r.aiScore,
                            rank: r.rank,
                            summary: r.summary,
                            strengths: r.strengths,
                            concerns: r.concerns,
                            rankedAt: now,
                        },
                    },
                },
            },
        }));
        await AppliedJob_1.AppliedJob.bulkWrite(ops, { ordered: false });
    }
    res.json({
        success: true,
        data: {
            rankings: result.rankings,
            usedAi: result.usedAi,
            cached: result.cached,
        },
        quota,
    });
});
exports.suggestJobCandidates = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const profile = await requireHirerProfile(req.user.id);
    const job = await requireOwnedJob(String(req.params.jobId), profile._id);
    const { limit, poolSize } = req.body;
    const finalLimit = Math.max(1, Math.min(20, limit ?? 10));
    const finalPool = Math.max(1, Math.min(50, poolSize ?? 50));
    const existingApplicants = await AppliedJob_1.AppliedJob.distinct('user', {
        job: job._id,
    });
    const candidateUserIds = await AppliedJob_1.AppliedJob.aggregate([
        {
            $match: {
                hirerProfile: profile._id,
                job: { $ne: job._id },
                status: { $nin: ['rejected', 'withdrawn'] },
                user: { $nin: existingApplicants },
            },
        },
        {
            $group: {
                _id: '$user',
                lastSeenAt: { $max: '$appliedAt' },
            },
        },
        { $sort: { lastSeenAt: -1 } },
        { $limit: finalPool },
    ]);
    if (candidateUserIds.length === 0) {
        const quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
        res.json({
            success: true,
            data: {
                suggestions: [],
                usedAi: false,
                cached: false,
                poolSize: 0,
            },
            quota,
        });
        return;
    }
    const users = await User_1.User.find({
        _id: { $in: candidateUserIds.map((c) => c._id) },
    }).select('profile.fullName profile.headline profile.experienceYears profile.skills profile.resumeText profile.avatar');
    const lastSeenMap = new Map(candidateUserIds.map((c) => [c._id.toString(), c.lastSeenAt]));
    const pool = users.map((u) => ({
        userId: u._id.toString(),
        fullName: u.profile?.fullName ?? 'Candidate',
        headline: u.profile?.headline,
        experienceYears: u.profile?.experienceYears,
        skills: u.profile?.skills ?? [],
        resumeText: u.profile?.resumeText,
        lastSeenAt: lastSeenMap.get(u._id.toString())?.toISOString(),
    }));
    const ids = pool.map((c) => c.userId);
    const cached = await (0, candidateSuggester_service_1.peekCachedSuggestions)(job._id.toString(), job.updatedAt, ids);
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (cached) {
        const trimmed = cached.slice(0, finalLimit);
        res.json({
            success: true,
            data: {
                suggestions: decorateWithProfile(trimmed, users, lastSeenMap),
                usedAi: true,
                cached: true,
                poolSize: pool.length,
            },
            quota,
        });
        return;
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)('candidate_suggest');
    quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, candidateSuggester_service_1.suggestCandidates)({
            job,
            pool,
            userId,
            limit: finalLimit,
        });
    }
    catch (err) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!result.usedAi)
        await (0, quota_service_1.refundQuota)(userId, weight);
    res.json({
        success: true,
        data: {
            suggestions: decorateWithProfile(result.suggestions, users, lastSeenMap),
            usedAi: result.usedAi,
            cached: result.cached,
            poolSize: result.poolSize,
        },
        quota,
    });
});
const decorateWithProfile = (suggestions, users, lastSeenMap) => {
    const byId = new Map(users.map((u) => [u._id.toString(), u]));
    return suggestions.map((s) => {
        const u = byId.get(s.userId);
        return {
            userId: s.userId,
            score: s.score,
            rank: s.rank,
            summary: s.summary,
            strengths: s.strengths,
            concerns: s.concerns,
            fullName: u?.profile?.fullName ?? 'Candidate',
            headline: u?.profile?.headline,
            avatar: u?.profile?.avatar,
            experienceYears: u?.profile?.experienceYears,
            topSkills: (u?.profile?.skills ?? []).slice(0, 6),
            lastSeenAt: lastSeenMap.get(s.userId)?.toISOString(),
        };
    });
};
exports.draftCandidateOutreach = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const profile = await requireHirerProfile(req.user.id);
    const job = await requireOwnedJob(String(req.params.jobId), profile._id);
    const candidateId = String(req.params.userId);
    if (!isObjectId(candidateId)) {
        throw ApiError_1.ApiError.badRequest('Invalid candidate id');
    }
    const candidate = await User_1.User.findById(candidateId).select('profile.fullName profile.headline profile.experienceYears profile.skills');
    if (!candidate)
        throw ApiError_1.ApiError.notFound('Candidate not found');
    const cached = await (0, recruiterOutreach_service_1.peekCachedOutreach)(job._id.toString(), candidate._id.toString(), job.updatedAt);
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (cached) {
        res.json({
            success: true,
            data: { drafts: cached, usedAi: true, cached: true },
            quota,
        });
        return;
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)('recruiter_outreach');
    if (weight > 0)
        quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, recruiterOutreach_service_1.draftRecruiterOutreach)({
            job,
            candidate,
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
    res.json({ success: true, data: result, quota });
});
exports.getApplicantResumeTldr = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid application id');
    const application = await AppliedJob_1.AppliedJob.findById(id).populate({
        path: 'user',
        select: 'profile.resumeText',
    });
    if (!application)
        throw ApiError_1.ApiError.notFound('Application not found');
    await requireOwnedJob(application.job.toString(), profile._id);
    const seeker = application.user;
    const resumeText = (seeker?.profile?.resumeText || '').trim();
    if (resumeText.length < 100) {
        const quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
        res.json({
            success: true,
            data: {
                summary: 'No resume text on file for this applicant.',
                strengths: [],
                yearsOfExperience: null,
                topRoles: [],
                usedAi: false,
                cached: false,
            },
            quota,
        });
        return;
    }
    const cached = await (0, resumeTldr_service_1.peekCachedTldr)(resumeText);
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (cached) {
        res.json({ success: true, data: cached, quota });
        return;
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)('resume_tldr');
    if (weight > 0)
        quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, resumeTldr_service_1.summariseResume)({ resumeText, userId });
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
