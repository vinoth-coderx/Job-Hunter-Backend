"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.unsaveJob = exports.saveJob = exports.listSavedJobIds = exports.listSavedJobs = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const SavedJob_1 = require("../models/SavedJob");
const Job_1 = require("../models/Job");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
exports.listSavedJobs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50);
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        SavedJob_1.SavedJob.find({ user: req.user._id })
            .sort({ savedAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('job')
            .lean(),
        SavedJob_1.SavedJob.countDocuments({ user: req.user._id }),
    ]);
    const jobs = items.map((s) => s.job).filter((j) => j);
    res.json({
        success: true,
        data: jobs,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    });
});
exports.listSavedJobIds = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const items = await SavedJob_1.SavedJob.find({ user: req.user._id }).select('job').lean();
    res.json({ success: true, data: items.map((s) => s.job.toString()) });
});
exports.saveJob = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id || '');
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid job id');
    const job = await Job_1.Job.findById(id).select('_id').lean();
    if (!job)
        throw ApiError_1.ApiError.notFound('Job not found');
    try {
        await SavedJob_1.SavedJob.create({
            user: req.user._id,
            job: new mongoose_1.default.Types.ObjectId(id),
        });
    }
    catch (err) {
        if (typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            err.code === 11000) {
            res.json({ success: true, message: 'Already saved' });
            return;
        }
        throw err;
    }
    res.status(201).json({ success: true, message: 'Job saved' });
});
exports.unsaveJob = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id || '');
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid job id');
    await SavedJob_1.SavedJob.deleteOne({
        user: req.user._id,
        job: new mongoose_1.default.Types.ObjectId(id),
    });
    res.json({ success: true, message: 'Removed' });
});
