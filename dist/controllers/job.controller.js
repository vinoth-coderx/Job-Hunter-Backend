"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.triggerFetch = exports.matchedJobs = exports.getJob = exports.clearCache = exports.warmCache = exports.listAllJobs = exports.listJobs = exports.listJobsSchema = void 0;
const zod_1 = require("zod");
const Job_1 = require("../models/Job");
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const redis_1 = require("../config/redis");
const env_1 = require("../config/env");
const matcher_service_1 = require("../services/ai/matcher.service");
const jobScraper_cron_1 = require("../jobs/jobScraper.cron");
const jobCache_service_1 = require("../services/jobCache.service");
const logger_1 = require("../utils/logger");
exports.listJobsSchema = zod_1.z.object({
    query: zod_1.z.object({
        q: zod_1.z.string().optional(),
        location: zod_1.z.string().optional(),
        company: zod_1.z.string().optional(),
        jobType: zod_1.z.string().optional(),
        remoteType: zod_1.z.string().optional(),
        skills: zod_1.z.string().optional(),
        minSalary: zod_1.z.coerce.number().optional(),
        page: zod_1.z.coerce.number().min(1).default(1),
        limit: zod_1.z.coerce.number().min(1).max(100).default(20),
        sort: zod_1.z.enum(['recent', 'salary', 'relevance']).default('recent'),
    }),
});
const buildFilter = (q) => {
    const cutoff = new Date(Date.now() - env_1.env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
    const filter = {
        isActive: true,
        postedAt: { $gte: cutoff },
    };
    const str = (v) => typeof v === 'string' && v.length > 0 ? v : undefined;
    const qStr = str(q.q);
    if (qStr)
        filter.$text = { $search: qStr };
    const loc = str(q.location);
    if (loc)
        filter.location = { $regex: loc, $options: 'i' };
    const company = str(q.company);
    if (company)
        filter.company = { $regex: company, $options: 'i' };
    if (str(q.jobType))
        filter.jobType = q.jobType;
    if (str(q.remoteType))
        filter.remoteType = q.remoteType;
    const skills = str(q.skills);
    if (skills) {
        const arr = skills.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (arr.length)
            filter.skills = { $in: arr };
    }
    if (q.minSalary)
        filter.salaryMin = { $gte: Number(q.minSalary) };
    return filter;
};
const SEARCH_PARAMS = ['q', 'location', 'company', 'jobType', 'remoteType', 'skills', 'minSalary'];
const isSearchMode = (q) => SEARCH_PARAMS.some((k) => typeof q[k] === 'string' && q[k].length > 0);
exports.listJobs = (0, asyncHandler_1.asyncHandler)(async (req, res, next) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const q = req.query;
    const numQ = (v, dflt) => {
        const n = typeof v === 'string' ? Number(v) : NaN;
        return Number.isFinite(n) ? n : dflt;
    };
    const page = numQ(q.page, 1);
    const limit = numQ(q.limit, 20);
    const skip = (page - 1) * limit;
    if (!isSearchMode(q)) {
        (0, exports.matchedJobs)(req, res, next);
        return;
    }
    const cacheKey = `jobs:search:${req.user.id}:${JSON.stringify(q)}`;
    const cached = await redis_1.redis.get(cacheKey);
    if (cached) {
        res.json(JSON.parse(cached));
        return;
    }
    const filter = buildFilter(q);
    const sort = { postedAt: -1 };
    if (q.sort === 'salary') {
        sort.salaryMax = -1;
        sort.salaryMin = -1;
    }
    const [items, total] = await Promise.all([
        Job_1.Job.find(filter).sort(sort).skip(skip).limit(limit).lean(),
        Job_1.Job.countDocuments(filter),
    ]);
    const payload = {
        success: true,
        mode: 'search',
        data: items,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
    await redis_1.redis.setex(cacheKey, env_1.env.REDIS_JOB_CACHE_TTL, JSON.stringify(payload));
    res.json(payload);
});
exports.listAllJobs = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const cached = await redis_1.redis.get(redis_1.CACHE_KEYS.ALL_JOBS);
    if (cached) {
        res.json(JSON.parse(cached));
        return;
    }
    const payload = await (0, jobCache_service_1.buildAllJobsPayload)();
    await redis_1.redis.setex(redis_1.CACHE_KEYS.ALL_JOBS, env_1.env.REDIS_JOB_CACHE_TTL, JSON.stringify(payload));
    res.json(payload);
});
exports.warmCache = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user || req.user.role !== 'admin')
        throw ApiError_1.ApiError.forbidden('Admin only');
    const result = await (0, jobCache_service_1.warmJobsCache)();
    res.json({ success: true, message: 'Cache warmed', data: result });
});
exports.clearCache = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user || req.user.role !== 'admin')
        throw ApiError_1.ApiError.forbidden('Admin only');
    const result = await (0, jobCache_service_1.clearJobsCache)();
    res.json({ success: true, message: 'Cache cleared', data: result });
});
exports.getJob = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = String(req.params.id);
    const cached = await redis_1.redis.get(redis_1.CACHE_KEYS.JOB_BY_ID(id));
    if (cached) {
        res.json({ success: true, data: JSON.parse(cached) });
        return;
    }
    const job = await Job_1.Job.findById(id).lean();
    if (!job)
        throw ApiError_1.ApiError.notFound('Job not found');
    await redis_1.redis.setex(redis_1.CACHE_KEYS.JOB_BY_ID(id), env_1.env.REDIS_JOB_CACHE_TTL, JSON.stringify(job));
    res.json({ success: true, data: job });
});
exports.matchedJobs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const useAi = req.query.ai === 'true';
    const thresholdRaw = typeof req.query.threshold === 'string' ? Number(req.query.threshold) : NaN;
    const threshold = Number.isFinite(thresholdRaw)
        ? Math.min(100, Math.max(0, thresholdRaw))
        : env_1.env.AI_MATCH_THRESHOLD;
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 100);
    const cacheKey = `${redis_1.CACHE_KEYS.USER_MATCHED_JOBS(req.user.id)}:${useAi}:${threshold}:${limit}`;
    const cached = await redis_1.redis.get(cacheKey);
    if (cached) {
        res.json(JSON.parse(cached));
        return;
    }
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const cutoff = new Date(Date.now() - env_1.env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
    const profileComplete = Boolean(user.profile.skills?.length || user.profile.preferredRoles?.length);
    if (!profileComplete) {
        const recent = await Job_1.Job.find({ isActive: true, postedAt: { $gte: cutoff } })
            .sort({ postedAt: -1 })
            .limit(limit)
            .lean();
        const fallbackPayload = {
            success: true,
            data: recent.map((j) => ({
                job: j,
                score: null,
                matchedSkills: [],
                missingSkills: [],
                reasoning: null,
            })),
            meta: {
                total: recent.length,
                threshold,
                useAi,
                profileIncomplete: true,
                nextStep: 'Add skills and preferred roles to your profile to get personalized 80%+ matches',
            },
        };
        await redis_1.redis.setex(cacheKey, 600, JSON.stringify(fallbackPayload));
        res.json(fallbackPayload);
        return;
    }
    const candidateFilter = {
        isActive: true,
        postedAt: { $gte: cutoff },
        $or: [
            ...(user.profile.skills?.length
                ? [{ skills: { $in: user.profile.skills.map((s) => s.toLowerCase()) } }]
                : []),
            ...(user.profile.preferredRoles?.length
                ? [{ title: { $regex: user.profile.preferredRoles.join('|'), $options: 'i' } }]
                : []),
        ],
    };
    const candidates = await Job_1.Job.find(candidateFilter).sort({ postedAt: -1 }).limit(1000);
    const matched = await (0, matcher_service_1.matchJobsForUser)(user, candidates, threshold, useAi);
    const top = matched.slice(0, limit);
    const payload = {
        success: true,
        data: top.map((m) => ({
            job: m.job,
            score: m.match.score,
            matchedSkills: m.match.matchedSkills,
            missingSkills: m.match.missingSkills,
            reasoning: m.match.reasoning,
        })),
        meta: {
            total: matched.length,
            threshold,
            useAi,
            profileIncomplete: false,
            candidatePoolSize: candidates.length,
        },
    };
    await redis_1.redis.setex(cacheKey, 1800, JSON.stringify(payload));
    res.json(payload);
});
exports.triggerFetch = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user || req.user.role !== 'admin')
        throw ApiError_1.ApiError.forbidden('Admin only');
    try {
        const result = await (0, jobScraper_cron_1.runJobFetchNow)();
        res.json({ success: true, message: 'Job fetch triggered', data: result });
    }
    catch (err) {
        logger_1.logger.error('Manual fetch failed', err);
        throw ApiError_1.ApiError.internal('Failed to trigger fetch');
    }
});
