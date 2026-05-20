"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewHirer = exports.approveHirerSchema = exports.reviewVerification = exports.reviewVerificationSchema = exports.listVerificationQueue = exports.bulkAckSecurityEvents = exports.acknowledgeSecurityEvent = exports.listSecurityEvents = exports.listAuditLogs = exports.resolveReport = exports.resolveReportSchema = exports.listReports = exports.resolveModerationAppeal = exports.resolveAppealSchema = exports.listModerationAppeals = exports.decideModeration = exports.moderationDecisionSchema = exports.listModerationQueue = void 0;
const zod_1 = require("zod");
const mongoose_1 = __importDefault(require("mongoose"));
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const Job_1 = require("../models/Job");
const JobModeration_1 = require("../models/JobModeration");
const Report_1 = require("../models/Report");
const AuditLog_1 = require("../models/AuditLog");
const SecurityEvent_1 = require("../models/SecurityEvent");
const Verification_1 = require("../models/Verification");
const HirerProfile_1 = require("../models/HirerProfile");
const audit_service_1 = require("../services/security/audit.service");
const trustScore_service_1 = require("../services/security/trustScore.service");
const notify_service_1 = require("../services/notification/notify.service");
exports.listModerationQueue = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const status = req.query.status || 'queued';
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const skip = Number(req.query.skip) || 0;
    const filter = {};
    if (status !== 'all')
        filter['moderation.status'] = status;
    filter.isNative = true;
    const [items, total] = await Promise.all([
        Job_1.Job.find(filter)
            .sort({ 'moderation.lastModelRun': -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('hirerProfile', 'companyName trustScore verification.isVerified')
            .populate('postedBy', 'email profile.fullName')
            .lean(),
        Job_1.Job.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, total } });
});
exports.moderationDecisionSchema = zod_1.z.object({
    body: zod_1.z.object({
        decision: zod_1.z.enum(['approve', 'reject']),
        note: zod_1.z.string().max(2000).optional(),
    }),
});
exports.decideModeration = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const job = await Job_1.Job.findById(req.params.id);
    if (!job)
        throw new ApiError_1.ApiError(404, 'Job not found');
    if (req.body.decision === 'approve') {
        job.moderation.status = 'approved';
        job.isPublic = true;
    }
    else {
        job.moderation.status = 'rejected';
        job.isPublic = false;
        job.status = 'closed';
    }
    job.moderation.reviewedAt = new Date();
    job.moderation.reviewedBy = req.user._id;
    job.moderation.reviewNote = req.body.note;
    await job.save();
    await JobModeration_1.JobModeration.findOneAndUpdate({ job: job._id }, {
        $set: {
            overrideDecision: req.body.decision === 'approve' ? 'approved' : 'rejected',
            overrideNote: req.body.note,
            reviewedBy: req.user._id,
            reviewedAt: new Date(),
        },
    }, { sort: { createdAt: -1 } });
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user._id, email: req.user.email },
        actorType: 'admin',
        category: 'job_moderation',
        action: `moderation:${req.body.decision}`,
        target: { type: 'Job', id: job._id, label: job.title },
        metadata: { note: req.body.note },
        req,
    });
    res.json({ success: true });
});
exports.listModerationAppeals = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const status = req.query.status || 'pending';
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const skip = Number(req.query.skip) || 0;
    const filter = { 'appeal.status': status };
    const [items, total] = await Promise.all([
        JobModeration_1.JobModeration.find(filter)
            .sort({ 'appeal.submittedAt': 1 })
            .skip(skip)
            .limit(limit)
            .populate('job', 'title company status moderation.status')
            .populate('hirer', 'email profile.fullName')
            .lean(),
        JobModeration_1.JobModeration.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, total } });
});
exports.resolveAppealSchema = zod_1.z.object({
    body: zod_1.z.object({
        decision: zod_1.z.enum(['accept', 'reject']),
        adminNote: zod_1.z.string().max(2000).optional(),
    }),
});
exports.resolveModerationAppeal = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = String(req.params.id);
    if (!mongoose_1.default.isValidObjectId(id))
        throw new ApiError_1.ApiError(400, 'Invalid id');
    const moderation = await JobModeration_1.JobModeration.findById(id);
    if (!moderation)
        throw new ApiError_1.ApiError(404, 'Moderation row not found');
    if (!moderation.appeal || moderation.appeal.status !== 'pending') {
        throw new ApiError_1.ApiError(400, 'No pending appeal on this row');
    }
    const { decision, adminNote } = req.body;
    const accepted = decision === 'accept';
    moderation.appeal.status = accepted ? 'accepted' : 'rejected';
    moderation.appeal.adminNote = adminNote;
    moderation.appeal.resolvedBy = req.user._id;
    moderation.appeal.resolvedAt = new Date();
    if (accepted) {
        moderation.overrideDecision = 'approved';
        moderation.overrideNote = adminNote;
        moderation.reviewedBy = req.user._id;
        moderation.reviewedAt = new Date();
    }
    await moderation.save();
    let republishedJobId;
    if (accepted) {
        const job = await Job_1.Job.findById(moderation.job);
        if (job) {
            job.moderation.status = 'approved';
            job.moderation.reviewedAt = new Date();
            job.moderation.reviewedBy = req.user._id;
            job.moderation.reviewNote = adminNote;
            job.isPublic = true;
            if (job.status === 'closed' && !job.closedAt) {
                job.status = 'active';
                job.isActive = true;
                job.publishedAt = job.publishedAt ?? new Date();
            }
            await job.save();
            republishedJobId = job._id.toString();
        }
    }
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user._id, email: req.user.email },
        actorType: 'admin',
        category: 'job_moderation',
        action: `moderation:appeal_${decision}`,
        target: { type: 'Job', id: moderation.job, label: undefined },
        metadata: { adminNote, republishedJobId },
        req,
    });
    const jobDoc = await Job_1.Job.findById(moderation.job).select('title');
    const title = accepted
        ? 'Your job has been re-approved'
        : 'Your appeal was reviewed';
    const body = accepted
        ? `"${jobDoc?.title ?? 'Your listing'}" is back live after admin review.`
        : `"${jobDoc?.title ?? 'Your listing'}" stays rejected. ${adminNote
            ? `Admin note: ${adminNote.slice(0, 200)}`
            : 'No further note from the reviewer.'}`;
    try {
        await (0, notify_service_1.notifyUser)({
            user: moderation.hirer,
            role: 'hirer',
            type: 'system',
            title,
            body,
            data: {
                subType: 'moderation_appeal',
                jobId: moderation.job.toString(),
                decision,
                adminNote: adminNote ?? null,
            },
        });
    }
    catch (err) {
        console.warn(`appeal notify skipped: ${err.message}`);
    }
    res.json({
        success: true,
        data: {
            appealStatus: moderation.appeal.status,
            republishedJobId,
        },
    });
});
exports.listReports = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const status = req.query.status || 'open';
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const filter = {};
    if (status !== 'all')
        filter.status = status;
    const reports = await Report_1.Report.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('reporter', 'email profile.fullName')
        .lean();
    res.json({ success: true, data: reports });
});
exports.resolveReportSchema = zod_1.z.object({
    body: zod_1.z.object({
        action: zod_1.z.enum([
            'job_unpublished',
            'recruiter_warned',
            'recruiter_suspended',
            'recruiter_banned',
            'company_flagged',
            'no_action',
        ]),
        note: zod_1.z.string().max(2000).optional(),
    }),
});
exports.resolveReport = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const report = await Report_1.Report.findById(req.params.id);
    if (!report)
        throw new ApiError_1.ApiError(404, 'Report not found');
    const status = req.body.action === 'no_action' ? 'dismissed' : 'actioned';
    report.status = status;
    report.action = req.body.action;
    report.resolutionNote = req.body.note;
    report.resolvedAt = new Date();
    report.resolvedBy = req.user._id;
    await report.save();
    if (req.body.action === 'job_unpublished' && report.subjectType === 'job') {
        await Job_1.Job.findByIdAndUpdate(report.subjectId, {
            $set: { isPublic: false, status: 'closed', 'moderation.status': 'rejected' },
        });
    }
    if ((req.body.action === 'recruiter_suspended' || req.body.action === 'recruiter_banned') &&
        report.subjectType === 'recruiter') {
        await HirerProfile_1.HirerProfile.findByIdAndUpdate(report.subjectId, {
            $set: { approvalStatus: req.body.action === 'recruiter_banned' ? 'banned' : 'suspended' },
        });
    }
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user._id, email: req.user.email },
        actorType: 'admin',
        category: 'security',
        action: `report:${req.body.action}`,
        target: { type: report.subjectType, id: report.subjectId },
        req,
    });
    res.json({ success: true });
});
exports.listAuditLogs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const skip = Number(req.query.skip) || 0;
    const filter = {};
    if (req.query.category)
        filter.category = req.query.category;
    if (req.query.actorType)
        filter.actorType = req.query.actorType;
    if (req.query.actor)
        filter.actor = new mongoose_1.default.Types.ObjectId(req.query.actor);
    if (typeof req.query.actionPrefix === 'string' && req.query.actionPrefix.length > 0) {
        const escaped = req.query.actionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.action = { $regex: `^${escaped}` };
    }
    const [items, total] = await Promise.all([
        AuditLog_1.AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        AuditLog_1.AuditLog.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, total } });
});
exports.listSecurityEvents = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const filter = {};
    if (req.query.severity)
        filter.severity = req.query.severity;
    if (req.query.acknowledged !== undefined)
        filter.acknowledged = req.query.acknowledged === 'true';
    const items = await SecurityEvent_1.SecurityEvent.find(filter)
        .sort({ createdAt: -1 })
        .limit(200)
        .populate('user', 'email profile.fullName')
        .lean();
    res.json({ success: true, data: items });
});
exports.acknowledgeSecurityEvent = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const ev = await SecurityEvent_1.SecurityEvent.findByIdAndUpdate(req.params.id, {
        $set: {
            acknowledged: true,
            acknowledgedBy: req.user._id,
            acknowledgedAt: new Date(),
            resolved: req.body.resolve === true,
            resolvedAt: req.body.resolve === true ? new Date() : undefined,
            resolutionNote: req.body.note,
        },
    }, { new: true });
    if (!ev)
        throw new ApiError_1.ApiError(404, 'Event not found');
    res.json({ success: true, data: ev });
});
exports.bulkAckSecurityEvents = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const ALLOWED = ['info', 'low', 'medium', 'high', 'critical'];
    const max = (req.body?.maxSeverity ?? 'low');
    const order = ALLOWED.indexOf(max);
    if (order < 0)
        throw new ApiError_1.ApiError(400, 'Invalid maxSeverity');
    const target = ALLOWED.slice(0, order + 1);
    const result = await SecurityEvent_1.SecurityEvent.updateMany({
        acknowledged: false,
        severity: { $in: Array.from(target) },
    }, {
        $set: {
            acknowledged: true,
            acknowledgedBy: req.user._id,
            acknowledgedAt: new Date(),
        },
    });
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user._id, email: req.user.email },
        actorType: 'admin',
        category: 'security',
        action: `security:bulk_ack:${max}`,
        metadata: { modified: result.modifiedCount ?? 0 },
        req,
    });
    res.json({ success: true, modified: result.modifiedCount ?? 0 });
});
exports.listVerificationQueue = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const status = req.query.status || 'pending';
    const items = await Verification_1.Verification.find(status === 'all' ? {} : { status })
        .sort({ createdAt: -1 })
        .limit(200)
        .populate('hirer', 'email profile.fullName')
        .populate('company', 'companyName website verification')
        .lean();
    res.json({ success: true, data: items });
});
exports.reviewVerificationSchema = zod_1.z.object({
    body: zod_1.z.object({
        decision: zod_1.z.enum(['approve', 'reject']),
        note: zod_1.z.string().max(2000).optional(),
    }),
});
exports.reviewVerification = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const v = await Verification_1.Verification.findById(req.params.id);
    if (!v)
        throw new ApiError_1.ApiError(404, 'Verification submission not found');
    v.status = req.body.decision === 'approve' ? 'approved' : 'rejected';
    v.reviewNote = req.body.note;
    v.reviewedBy = req.user._id;
    v.reviewedAt = new Date();
    await v.save();
    if (req.body.decision === 'approve') {
        const profile = await HirerProfile_1.HirerProfile.findById(v.company);
        if (profile) {
            const k = v.channel === 'domain_email' ? 'domainEmail' : v.channel;
            profile.verification.levels[k] = true;
            profile.verification.isVerified = Object.values(profile.verification.levels).some(Boolean);
            if (profile.verification.isVerified && !profile.verification.verifiedAt) {
                profile.verification.verifiedAt = new Date();
            }
            await profile.save();
            await (0, trustScore_service_1.recomputeHirerTrust)(profile.user);
        }
    }
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user._id, email: req.user.email },
        actorType: 'admin',
        category: 'verification',
        action: `verification:${v.channel}:${req.body.decision}`,
        target: { type: 'Verification', id: v._id },
        metadata: { note: req.body.note },
        req,
    });
    res.json({ success: true });
});
exports.approveHirerSchema = zod_1.z.object({
    body: zod_1.z.object({
        decision: zod_1.z.enum(['approve', 'suspend', 'ban']),
        note: zod_1.z.string().max(2000).optional(),
    }),
});
exports.reviewHirer = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const profile = await HirerProfile_1.HirerProfile.findById(req.params.id);
    if (!profile)
        throw new ApiError_1.ApiError(404, 'Hirer profile not found');
    const map = { approve: 'approved', suspend: 'suspended', ban: 'banned' };
    profile.approvalStatus = map[req.body.decision];
    profile.approvalNote = req.body.note;
    if (req.body.decision === 'approve') {
        profile.approvedAt = new Date();
        profile.approvedBy = req.user._id;
    }
    await profile.save();
    await (0, trustScore_service_1.recomputeHirerTrust)(profile.user);
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user._id, email: req.user.email },
        actorType: 'admin',
        category: 'hirer',
        action: `hirer:${req.body.decision}`,
        target: { type: 'HirerProfile', id: profile._id, label: profile.companyName },
        metadata: { note: req.body.note },
        req,
    });
    res.json({ success: true });
});
