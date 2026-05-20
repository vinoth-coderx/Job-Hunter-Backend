"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHirerAttentionEndpoint = exports.getHirerDigestEndpoint = exports.getHirerAnalytics = void 0;
const HirerProfile_1 = require("../models/HirerProfile");
const Job_1 = require("../models/Job");
const AppliedJob_1 = require("../models/AppliedJob");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const hirerDigest_service_1 = require("../services/ai/hirerDigest.service");
const quota_service_1 = require("../services/ai/quota.service");
const aiCreditWeights_1 = require("../config/aiCreditWeights");
const attention_service_1 = require("../services/hirer/attention.service");
const requireHirerProfile = async (userId) => {
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: userId });
    if (!profile)
        throw ApiError_1.ApiError.forbidden('Set up a company profile first');
    return profile;
};
exports.getHirerAnalytics = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const myJobs = await Job_1.Job.find({
        hirerProfile: profile._id,
        isNative: true,
    })
        .select('_id title applicationsCount shortlistedCount publishedAt status')
        .lean();
    if (myJobs.length === 0) {
        res.json({
            success: true,
            data: {
                totalJobs: 0,
                totalApplications: 0,
                funnel: [],
                sourceBreakdown: [],
                topJobs: [],
                timeToHireDays: null,
                daily30: [],
            },
        });
        return;
    }
    const jobIds = myJobs.map((j) => j._id);
    const funnelAgg = await AppliedJob_1.AppliedJob.aggregate([
        { $match: { job: { $in: jobIds } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const FUNNEL_ORDER = [
        'applied',
        'viewed',
        'shortlisted',
        'interview',
        'offer',
        'hired',
        'rejected',
        'withdrawn',
    ];
    const funnelMap = new Map(funnelAgg.map((b) => [b._id, b.count]));
    const funnel = FUNNEL_ORDER.map((s) => ({
        status: s,
        count: funnelMap.get(s) ?? 0,
    }));
    const sourceAgg = await AppliedJob_1.AppliedJob.aggregate([
        { $match: { job: { $in: jobIds } } },
        { $group: { _id: '$applyType', count: { $sum: 1 } } },
    ]);
    const sourceBreakdown = sourceAgg
        .map((b) => ({ source: b._id, count: b.count }))
        .sort((a, b) => b.count - a.count);
    const topJobs = [...myJobs]
        .sort((a, b) => (b.applicationsCount ?? 0) - (a.applicationsCount ?? 0))
        .slice(0, 5)
        .map((j) => ({
        jobId: j._id.toString(),
        title: j.title,
        applicationsCount: j.applicationsCount ?? 0,
        shortlistedCount: j.shortlistedCount ?? 0,
        status: j.status,
    }));
    const hired = await AppliedJob_1.AppliedJob.find({
        job: { $in: jobIds },
        status: 'hired',
    })
        .select('appliedAt statusHistory')
        .lean();
    let timeToHireDays = null;
    if (hired.length > 0) {
        const deltas = [];
        for (const h of hired) {
            const hiredEntry = h.statusHistory?.find((s) => s.status === 'hired');
            const at = hiredEntry?.changedAt ?? null;
            if (!at)
                continue;
            const ms = new Date(at).getTime() - new Date(h.appliedAt).getTime();
            if (ms > 0)
                deltas.push(ms / (1000 * 60 * 60 * 24));
        }
        if (deltas.length > 0) {
            timeToHireDays = Math.round(deltas.reduce((s, n) => s + n, 0) / deltas.length);
        }
    }
    const since = new Date();
    since.setDate(since.getDate() - 29);
    since.setHours(0, 0, 0, 0);
    const daily = await AppliedJob_1.AppliedJob.aggregate([
        {
            $match: {
                job: { $in: jobIds },
                appliedAt: { $gte: since },
            },
        },
        {
            $group: {
                _id: {
                    $dateToString: { format: '%Y-%m-%d', date: '$appliedAt' },
                },
                count: { $sum: 1 },
            },
        },
        { $sort: { _id: 1 } },
    ]);
    const dailyMap = new Map(daily.map((d) => [d._id, d.count]));
    const daily30 = [];
    for (let i = 0; i < 30; i++) {
        const d = new Date(since);
        d.setDate(since.getDate() + i);
        const key = d.toISOString().slice(0, 10);
        daily30.push({ date: key, count: dailyMap.get(key) ?? 0 });
    }
    const totalApplications = funnel.reduce((s, b) => s + b.count, 0);
    res.json({
        success: true,
        data: {
            totalJobs: myJobs.length,
            totalApplications,
            funnel,
            sourceBreakdown,
            topJobs,
            timeToHireDays,
            daily30,
        },
    });
});
exports.getHirerDigestEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const profile = await requireHirerProfile(req.user.id);
    const cached = await (0, hirerDigest_service_1.peekCachedDigest)(profile._id.toString());
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (cached) {
        res.json({
            success: true,
            data: { ...cached, cached: true },
            quota,
        });
        return;
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)('hirer_digest');
    if (weight > 0)
        quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, hirerDigest_service_1.generateHirerDigest)({
            hirerProfileId: profile._id,
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
exports.getHirerAttentionEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const data = await (0, attention_service_1.buildHirerAttention)(profile._id);
    res.json({ success: true, data });
});
