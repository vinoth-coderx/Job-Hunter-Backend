"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appliedStats = exports.deleteApplied = exports.updateApplied = exports.listApplied = exports.quickApply = exports.applyToJob = exports.updateAppliedSchema = exports.quickApplySchema = exports.applySchema = void 0;
const zod_1 = require("zod");
const Job_1 = require("../models/Job");
const AppliedJob_1 = require("../models/AppliedJob");
const Notification_1 = require("../models/Notification");
const HirerProfile_1 = require("../models/HirerProfile");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const matcher_service_1 = require("../services/ai/matcher.service");
const User_1 = require("../models/User");
const jobScraper_cron_1 = require("../jobs/jobScraper.cron");
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
    const job = await Job_1.Job.findById(jobId);
    if (!job)
        throw ApiError_1.ApiError.notFound('Job not found');
    const exists = await AppliedJob_1.AppliedJob.findOne({ user: req.user._id, job: jobId });
    if (exists)
        throw ApiError_1.ApiError.conflict('You have already applied to this job');
    const user = await User_1.User.findById(req.user._id);
    const score = user ? (0, matcher_service_1.heuristicMatch)(user, job).score : undefined;
    const applied = await AppliedJob_1.AppliedJob.create({
        user: req.user._id,
        job: job._id,
        jobSnapshot: {
            title: job.title,
            company: job.company,
            location: job.location,
            url: job.url,
        },
        notes,
        matchScore: score,
        status: 'applied',
    });
    res.status(201).json({ success: true, message: 'Marked as applied', data: applied });
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
    const score = (0, matcher_service_1.heuristicMatch)(user, job).score;
    const applied = await AppliedJob_1.AppliedJob.create({
        user: req.user._id,
        job: job._id,
        hirerProfile: job.hirerProfile,
        jobSnapshot: {
            title: job.title,
            company: job.company,
            location: job.location,
            url: job.url,
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
    if (job.hirerProfile) {
        const hirer = await HirerProfile_1.HirerProfile.findById(job.hirerProfile).select('user').lean();
        if (hirer?.user) {
            try {
                await Notification_1.Notification.create({
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
            }
            catch {
            }
        }
    }
    res.status(201).json({ success: true, message: 'Application sent', data: applied });
});
exports.listApplied = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20);
    const skip = (page - 1) * limit;
    const cutoff = new Date(Date.now() - jobScraper_cron_1.APPLIED_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const filter = {
        user: req.user._id,
        appliedAt: { $gte: cutoff },
    };
    if (status)
        filter.status = status;
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
