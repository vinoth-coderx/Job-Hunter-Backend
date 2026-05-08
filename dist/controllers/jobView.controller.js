"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordJobView = void 0;
const Job_1 = require("../models/Job");
const JobView_1 = require("../models/JobView");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
exports.recordJobView = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = String(req.params.id || '');
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid job id');
    const job = await Job_1.Job.findById(id).select('_id').lean();
    if (!job)
        throw ApiError_1.ApiError.notFound('Job not found');
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const userId = req.user?._id;
    const deviceIdRaw = req.header('x-device-id');
    const deviceId = typeof deviceIdRaw === 'string' && deviceIdRaw.length > 0 && deviceIdRaw.length <= 200
        ? deviceIdRaw
        : undefined;
    if (!userId && !deviceId) {
        res.json({ success: true, counted: false, reason: 'no-identity' });
        return;
    }
    const dedupeFilter = userId
        ? { job: id, user: userId, viewedAt: { $gte: since } }
        : { job: id, deviceId, user: { $exists: false }, viewedAt: { $gte: since } };
    const existing = await JobView_1.JobView.findOne(dedupeFilter).select('_id').lean();
    if (existing) {
        res.json({ success: true, counted: false });
        return;
    }
    await JobView_1.JobView.create({
        job: id,
        ...(userId ? { user: userId } : {}),
        ...(deviceId ? { deviceId } : {}),
        viewedAt: new Date(),
    });
    try {
        await Job_1.Job.updateOne({ _id: id }, { $inc: { viewsCount: 1 } });
    }
    catch {
    }
    res.json({ success: true, counted: true });
});
