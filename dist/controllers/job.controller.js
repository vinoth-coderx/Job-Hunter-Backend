"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiSearchJobs = exports.aiSearchSchema = exports.matchedJobs = exports.getJob = exports.listAllJobs = exports.listJobs = exports.listJobsSchema = void 0;
const zod_1 = require("zod");
const Job_1 = require("../models/Job");
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const matcher_service_1 = require("../services/ai/matcher.service");
const jobSearch_service_1 = require("../services/ai/jobSearch.service");
const jobCache_service_1 = require("../services/jobCache.service");
const jobFeed_service_1 = require("../services/jobFeed.service");
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const EXTERNAL_ID_RE = /^([a-z][a-z0-9_]*):(.+)$/i;
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
const SEARCH_PARAMS = [
    'q',
    'location',
    'company',
    'jobType',
    'remoteType',
    'skills',
    'minSalary',
];
const isSearchMode = (q) => SEARCH_PARAMS.some((k) => typeof q[k] === 'string' && q[k].length > 0);
const str = (v) => typeof v === 'string' && v.length > 0 ? v : undefined;
const numQ = (v, dflt) => {
    const n = typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : dflt;
};
const buildNativeFilter = (q) => {
    const filter = {
        isNative: true,
        isActive: true,
        status: 'active',
        isPublic: true,
    };
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
        const arr = skills
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        if (arr.length)
            filter.skills = { $in: arr };
    }
    if (q.minSalary)
        filter.salaryMin = { $gte: Number(q.minSalary) };
    return filter;
};
const applyExternalFilters = (jobs, q) => {
    const qStr = str(q.q)?.toLowerCase();
    const loc = str(q.location)?.toLowerCase();
    const company = str(q.company)?.toLowerCase();
    const jobType = str(q.jobType);
    const remoteType = str(q.remoteType);
    const skillsCsv = str(q.skills);
    const minSalary = q.minSalary ? Number(q.minSalary) : undefined;
    const requiredSkills = skillsCsv
        ? skillsCsv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        : [];
    return jobs.filter((j) => {
        if (qStr) {
            const hay = `${j.title} ${j.description} ${j.company}`.toLowerCase();
            if (!hay.includes(qStr))
                return false;
        }
        if (loc && !j.location.toLowerCase().includes(loc))
            return false;
        if (company && !j.company.toLowerCase().includes(company))
            return false;
        if (jobType && j.jobType !== jobType)
            return false;
        if (remoteType && j.remoteType !== remoteType)
            return false;
        if (requiredSkills.length) {
            const have = (j.skills || []).map((s) => s.toLowerCase());
            if (!requiredSkills.some((s) => have.includes(s)))
                return false;
        }
        if (minSalary !== undefined) {
            if (typeof j.salaryMin === 'number') {
                if (j.salaryMin < minSalary)
                    return false;
            }
            else if (typeof j.salaryMax === 'number') {
                if (j.salaryMax < minSalary)
                    return false;
            }
            else {
            }
        }
        return true;
    });
};
const filterRelevance = (job, q) => {
    let total = 0;
    let hit = 0;
    const qStr = str(q.q)?.toLowerCase();
    if (qStr) {
        total += 1;
        const titleLc = job.title.toLowerCase();
        const skillBag = (job.skills || []).join(' ').toLowerCase();
        if (titleLc.includes(qStr) || skillBag.includes(qStr)) {
            hit += 1;
        }
        else if (job.description.toLowerCase().includes(qStr)) {
            hit += 0.5;
        }
    }
    const loc = str(q.location)?.toLowerCase();
    if (loc) {
        total += 1;
        if (job.location.toLowerCase().includes(loc))
            hit += 1;
    }
    const skillsCsv = str(q.skills);
    if (skillsCsv) {
        const req = skillsCsv
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        if (req.length > 0) {
            const have = (job.skills || []).map((s) => s.toLowerCase());
            const titleLc = job.title.toLowerCase();
            const descLc = job.description.toLowerCase();
            const matchedCount = req.filter((s) => have.some((h) => h.includes(s)) ||
                titleLc.includes(s) ||
                descLc.includes(s)).length;
            total += req.length;
            hit += matchedCount;
        }
    }
    if (total === 0)
        return 100;
    return Math.round((hit / total) * 100);
};
const STOPWORDS = new Set([
    'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or',
    'the', 'to', 'with', 'job', 'jobs', 'role', 'roles', 'work',
]);
const matchesRawQ = (job, rawQ) => {
    if (!rawQ)
        return true;
    const tokens = rawQ
        .toLowerCase()
        .split(/[\s,/+&|()\-]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    if (tokens.length === 0)
        return true;
    const haystack = [
        job.title,
        (job.skills || []).join(' '),
        (job.responsibilities || []).join(' '),
        job.department || '',
        job.description,
    ]
        .join(' ')
        .toLowerCase();
    return tokens.every((t) => haystack.includes(t));
};
const sortFeedJobs = (jobs, sort) => {
    if (sort === 'salary') {
        return [...jobs].sort((a, b) => {
            const aSal = a.salaryMax ?? a.salaryMin ?? 0;
            const bSal = b.salaryMax ?? b.salaryMin ?? 0;
            return bSal - aSal;
        });
    }
    return [...jobs].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
};
exports.listJobs = (0, asyncHandler_1.asyncHandler)(async (req, res, next) => {
    const q = req.query;
    const page = numQ(q.page, 1);
    const limit = numQ(q.limit, 20);
    const skip = (page - 1) * limit;
    if (!isSearchMode(q) && req.user) {
        (0, exports.matchedJobs)(req, res, next);
        return;
    }
    const user = req.user ? await User_1.User.findById(req.user._id) : null;
    const nativeFilter = buildNativeFilter(q);
    const native = await Job_1.Job.find(nativeFilter).limit(500).lean();
    const nativeFeed = await (0, jobFeed_service_1.hydrateTrust)(native.map((n) => (0, jobFeed_service_1.toFeedJobFromNative)(n)));
    const queries = (0, jobFeed_service_1.deriveProfileQueries)(user, str(q.q));
    const locations = (0, jobFeed_service_1.deriveProfileLocations)(user, str(q.location));
    const externalScraped = queries.length
        ? await (0, jobFeed_service_1.fetchExternalForProfile)(queries, locations)
        : [];
    const externalFeed = applyExternalFilters(externalScraped.map(jobFeed_service_1.toFeedJobFromScraped), q);
    const rawQ = str(q.q);
    const merged = [...nativeFeed, ...externalFeed];
    const applied = await (0, jobFeed_service_1.buildAppliedExclusion)(req.user?._id?.toString());
    const dedupedByApply = (0, jobFeed_service_1.filterApplied)(merged, applied);
    const phraseMatched = dedupedByApply.filter((j) => matchesRawQ(j, rawQ));
    const ranked = phraseMatched
        .map((j) => ({ job: j, score: filterRelevance(j, q) }))
        .sort((a, b) => b.score - a.score)
        .map((r) => r.job);
    const sorted = sortFeedJobs(ranked, str(q.sort));
    const total = sorted.length;
    const items = sorted.slice(skip, skip + limit);
    res.json({
        success: true,
        mode: 'search',
        data: items,
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
            nativeCount: nativeFeed.length,
            externalCount: externalFeed.length,
            candidatePoolSize: dedupedByApply.length,
            ...(total === 0
                ? {
                    noMatches: true,
                    nextStep: 'No results match all your filters. Try broadening the search or removing one filter.',
                }
                : {}),
        },
    });
});
exports.listAllJobs = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const payload = await (0, jobCache_service_1.buildAllJobsPayload)();
    res.json(payload);
});
exports.getJob = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = String(req.params.id);
    if (OBJECT_ID_RE.test(id)) {
        const job = await Job_1.Job.findById(id)
            .populate('hirerProfile', 'verification trustScore approvalStatus')
            .lean();
        if (!job)
            throw ApiError_1.ApiError.notFound('Job not found');
        const hp = job.hirerProfile;
        res.json({
            success: true,
            data: {
                ...(0, jobFeed_service_1.toFeedJobFromNative)(job),
                companyVerified: hp?.verification?.isVerified === true,
                recruiterTrustScore: hp?.trustScore ?? null,
                recruiterApproved: (hp?.approvalStatus ?? 'approved') === 'approved',
            },
        });
        return;
    }
    const m = EXTERNAL_ID_RE.exec(id);
    if (m) {
        const source = m[1];
        const externalId = m[2];
        const cached = await (0, jobFeed_service_1.lookupExternalJobFromCache)(source, externalId);
        if (!cached) {
            throw ApiError_1.ApiError.notFound('External job not in cache. Re-open from search results.');
        }
        res.json({ success: true, data: (0, jobFeed_service_1.toFeedJobFromScraped)(cached) });
        return;
    }
    throw ApiError_1.ApiError.badRequest('Invalid job id');
});
const DEFAULT_MATCH_FLOOR = 30;
exports.matchedJobs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const useAi = req.query.ai === 'true';
    const thresholdRaw = typeof req.query.threshold === 'string' ? Number(req.query.threshold) : NaN;
    const threshold = Number.isFinite(thresholdRaw)
        ? Math.min(100, Math.max(0, thresholdRaw))
        : DEFAULT_MATCH_FLOOR;
    const page = Math.max(1, numQ(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, numQ(req.query.limit, 20)));
    const skip = (page - 1) * limit;
    if (req.user.role === 'guest') {
        const baseFilter = { isNative: true, isActive: true, status: 'active' };
        const [items, total] = await Promise.all([
            Job_1.Job.find(baseFilter).sort({ postedAt: -1 }).skip(skip).limit(limit).lean(),
            Job_1.Job.countDocuments(baseFilter),
        ]);
        const feedItems = await (0, jobFeed_service_1.hydrateTrust)(items.map((j) => (0, jobFeed_service_1.toFeedJobFromNative)(j)));
        res.json({
            success: true,
            data: feedItems.map((job) => ({
                job,
                score: null,
                matchedSkills: [],
                missingSkills: [],
                reasoning: null,
            })),
            meta: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasMore: skip + items.length < total,
                threshold,
                useAi: false,
                guest: true,
                nextStep: 'Sign in with Google to get personalised matches.',
            },
        });
        return;
    }
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const profileComplete = Boolean(user.profile.skills?.length || user.profile.preferredRoles?.length);
    if (!profileComplete) {
        const baseFilter = { isNative: true, isActive: true, status: 'active' };
        const [items, total] = await Promise.all([
            Job_1.Job.find(baseFilter).sort({ postedAt: -1 }).skip(skip).limit(limit).lean(),
            Job_1.Job.countDocuments(baseFilter),
        ]);
        const feedItems = await (0, jobFeed_service_1.hydrateTrust)(items.map((j) => (0, jobFeed_service_1.toFeedJobFromNative)(j)));
        res.json({
            success: true,
            data: feedItems.map((job) => ({
                job,
                score: null,
                matchedSkills: [],
                missingSkills: [],
                reasoning: null,
            })),
            meta: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasMore: skip + items.length < total,
                threshold,
                useAi,
                profileIncomplete: true,
                nextStep: 'Add skills and preferred roles to your profile to get personalised matches.',
            },
        });
        return;
    }
    const candidateFilter = {
        isNative: true,
        isActive: true,
        status: 'active',
        $or: [
            ...(user.profile.skills?.length
                ? [{ skills: { $in: user.profile.skills.map((s) => s.toLowerCase()) } }]
                : []),
            ...(user.profile.preferredRoles?.length
                ? [
                    {
                        title: {
                            $regex: user.profile.preferredRoles.join('|'),
                            $options: 'i',
                        },
                    },
                ]
                : []),
        ],
    };
    const nativeDocs = await Job_1.Job.find(candidateFilter)
        .sort({ postedAt: -1 })
        .limit(500)
        .lean();
    const nativeFeed = await (0, jobFeed_service_1.hydrateTrust)(nativeDocs.map((n) => (0, jobFeed_service_1.toFeedJobFromNative)(n)));
    const queries = (0, jobFeed_service_1.deriveProfileQueries)(user);
    const locations = (0, jobFeed_service_1.deriveProfileLocations)(user);
    const externalScraped = await (0, jobFeed_service_1.fetchExternalForProfile)(queries, locations);
    const externalFeed = externalScraped.map(jobFeed_service_1.toFeedJobFromScraped);
    const applied = await (0, jobFeed_service_1.buildAppliedExclusion)(req.user._id?.toString());
    const merged = (0, jobFeed_service_1.filterApplied)([...nativeFeed, ...externalFeed], applied);
    const matched = await (0, matcher_service_1.matchJobsForUser)(user, merged, threshold, useAi);
    if (matched.length === 0) {
        res.json({
            success: true,
            data: [],
            meta: {
                page,
                limit,
                total: 0,
                totalPages: 0,
                hasMore: false,
                threshold,
                useAi,
                profileIncomplete: false,
                noMatches: true,
                candidatePoolSize: merged.length,
                nextStep: 'No jobs cleared the match threshold. Add more skills / preferred roles to your profile, or broaden your preferred locations.',
            },
        });
        return;
    }
    const total = matched.length;
    const slice = matched.slice(skip, skip + limit);
    res.json({
        success: true,
        data: slice.map((m) => ({
            job: m.job,
            score: m.match.score,
            matchedSkills: m.match.matchedSkills,
            missingSkills: m.match.missingSkills,
            reasoning: m.match.reasoning,
        })),
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore: skip + slice.length < total,
            threshold,
            useAi,
            profileIncomplete: false,
            candidatePoolSize: merged.length,
            nativeCount: nativeFeed.length,
            externalCount: externalFeed.length,
        },
    });
});
exports.aiSearchSchema = zod_1.z.object({
    body: zod_1.z.object({
        query: zod_1.z.string().min(1).max(500),
        limit: zod_1.z.coerce.number().min(1).max(50).optional(),
        excludeAppliedJobs: zod_1.z.boolean().optional().default(true),
    }),
});
exports.aiSearchJobs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { query, limit, excludeAppliedJobs } = req.body;
    const applied = excludeAppliedJobs
        ? await (0, jobFeed_service_1.buildAppliedExclusion)(req.user?._id?.toString())
        : undefined;
    const result = await (0, jobSearch_service_1.aiJobSearch)({
        query,
        limit: limit ?? 30,
        excludeApplied: applied,
    });
    res.json({
        success: true,
        data: result.jobs,
        meta: {
            intent: result.intent,
            total: result.total,
            scope: result.scope,
            nativeCount: result.nativeCount,
            externalCount: result.externalCount,
        },
    });
});
