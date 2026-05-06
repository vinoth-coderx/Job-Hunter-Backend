"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appliedStats = exports.deleteApplied = exports.updateApplied = exports.listApplied = exports.applyToJob = exports.updateAppliedSchema = exports.applySchema = void 0;
const zod_1 = require("zod");
const Job_1 = require("../models/Job");
const AppliedJob_1 = require("../models/AppliedJob");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const matcher_service_1 = require("../services/ai/matcher.service");
const User_1 = require("../models/User");
exports.applySchema = zod_1.z.object({
    body: zod_1.z.object({
        jobId: zod_1.z.string().min(1),
        notes: zod_1.z.string().max(2000).optional(),
    }),
});
exports.updateAppliedSchema = zod_1.z.object({
    body: zod_1.z.object({
        status: zod_1.z.enum(['applied', 'viewed', 'interview', 'offer', 'rejected', 'withdrawn']).optional(),
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
exports.listApplied = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20);
    const skip = (page - 1) * limit;
    const filter = { user: req.user._id };
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
