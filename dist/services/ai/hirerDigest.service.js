"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateHirerDigest = exports.peekCachedDigest = exports.buildDigestSnapshot = void 0;
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const AppliedJob_1 = require("../../models/AppliedJob");
const Job_1 = require("../../models/Job");
const cacheKey = (hirerProfileId, day) => `ai:hirer-digest:${hirerProfileId}:${day}`;
const todayKey = () => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
const buildDigestSnapshot = async (hirerProfileId) => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const jobs = await Job_1.Job.find({
        hirerProfile: hirerProfileId,
        isNative: true,
        status: { $in: ['active', 'paused'] },
    })
        .select('_id title applicationsCount shortlistedCount publishedAt')
        .lean();
    if (jobs.length === 0) {
        return {
            windowDays: 7,
            totalJobsActive: 0,
            totalApplicationsThisWeek: 0,
            totalShortlistedThisWeek: 0,
            jobs: [],
        };
    }
    const jobIds = jobs.map((j) => j._id);
    const facets = await AppliedJob_1.AppliedJob.aggregate([
        {
            $match: {
                job: { $in: jobIds },
                appliedAt: { $gte: sevenDaysAgo },
            },
        },
        {
            $group: {
                _id: '$job',
                new: { $sum: 1 },
                shortlisted: {
                    $sum: {
                        $cond: [
                            {
                                $in: ['$status', ['shortlisted', 'interview', 'offer', 'hired']],
                            },
                            1,
                            0,
                        ],
                    },
                },
            },
        },
        { $project: { _id: 1, new: 1, shortlisted: 1 } },
        { $facet: { perJob: [{ $project: { _id: 1, new: 1, shortlisted: 1 } }] } },
    ]);
    const perJob = new Map();
    for (const row of facets[0]?.perJob ?? []) {
        perJob.set(row._id.toString(), {
            new: row.new,
            shortlisted: row.shortlisted,
        });
    }
    const now = Date.now();
    const enriched = jobs
        .map((j) => {
        const id = j._id.toString();
        const stats = perJob.get(id) ?? { new: 0, shortlisted: 0 };
        const daysSincePosted = j.publishedAt
            ? Math.max(0, Math.floor((now - new Date(j.publishedAt).getTime()) /
                (1000 * 60 * 60 * 24)))
            : 0;
        return {
            jobId: id,
            title: j.title,
            totalApplications: j.applicationsCount ?? 0,
            newThisWeek: stats.new,
            shortlisted: stats.shortlisted,
            daysSincePosted,
        };
    })
        .sort((a, b) => b.newThisWeek - a.newThisWeek);
    return {
        windowDays: 7,
        totalJobsActive: jobs.length,
        totalApplicationsThisWeek: enriched.reduce((s, j) => s + j.newThisWeek, 0),
        totalShortlistedThisWeek: enriched.reduce((s, j) => s + j.shortlisted, 0),
        jobs: enriched.slice(0, 8),
    };
};
exports.buildDigestSnapshot = buildDigestSnapshot;
const SYSTEM_PROMPT = `You write a short weekly digest for a hiring manager looking at their dashboard. Keep it specific, factual, and actionable.

RULES:
- Output STRICT JSON: {"headline": "...", "bullets": ["...", "..."]}.
- "headline": one sentence (max 120 chars), summarising the week's most important fact (e.g. which job pulled the most applicants, or which is stalling).
- "bullets": 2-4 short next-action items, each 8-18 words. Each must reference a SPECIFIC job by title.
- Don't invent counts that aren't in the snapshot.
- If a job has 0 applicants in 7 days AND was posted >5 days ago, suggest reviewing the JD or refreshing it.
- If a job has many applicants but 0 shortlisted, suggest reviewing the new applicants.
- Skip generic platitudes ("hiring is going well", "keep it up").
- Output ONLY the JSON, no markdown fences, no prose.`;
const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object')
        return null;
    const obj = raw;
    const headline = typeof obj.headline === 'string' ? obj.headline.trim().slice(0, 200) : '';
    if (!headline)
        return null;
    const bullets = Array.isArray(obj.bullets)
        ? obj.bullets
            .map((b) => (typeof b === 'string' ? b.trim() : ''))
            .filter((b) => b.length >= 6 && b.length <= 280)
            .slice(0, 4)
        : [];
    return { headline, bullets };
};
const heuristicDigest = (snapshot) => {
    if (snapshot.totalJobsActive === 0) {
        return {
            headline: 'No active jobs yet — post your first listing to start hiring.',
            bullets: [],
        };
    }
    if (snapshot.totalApplicationsThisWeek === 0) {
        return {
            headline: 'No new applicants in the last 7 days across your active listings.',
            bullets: snapshot.jobs.slice(0, 3).map((j) => `Review the JD for "${j.title}" — ${j.daysSincePosted}d since posting with no recent traction.`),
        };
    }
    const top = snapshot.jobs[0];
    const stalling = snapshot.jobs.find((j) => j.newThisWeek === 0 && j.daysSincePosted > 5);
    const headline = top
        ? `"${top.title}" pulled ${top.newThisWeek} new applicant${top.newThisWeek === 1 ? '' : 's'} this week.`
        : `${snapshot.totalApplicationsThisWeek} new applicants across your jobs this week.`;
    const bullets = [];
    if (top && top.shortlisted === 0 && top.newThisWeek > 0) {
        bullets.push(`Review the ${top.newThisWeek} new applicants for "${top.title}" — none shortlisted yet.`);
    }
    if (stalling) {
        bullets.push(`Refresh "${stalling.title}" — ${stalling.daysSincePosted}d old with zero new applicants.`);
    }
    if (snapshot.totalShortlistedThisWeek > 0) {
        bullets.push(`Move ${snapshot.totalShortlistedThisWeek} shortlisted candidates to interview.`);
    }
    return { headline, bullets };
};
const peekCachedDigest = async (hirerProfileId) => {
    try {
        const raw = await redis_1.redis.get(cacheKey(hirerProfileId, todayKey()));
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
exports.peekCachedDigest = peekCachedDigest;
const generateHirerDigest = async (args) => {
    const profileIdStr = args.hirerProfileId.toString();
    const ck = cacheKey(profileIdStr, todayKey());
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            const parsed = JSON.parse(cached);
            return { ...parsed, cached: true };
        }
    }
    catch (err) {
        logger_1.logger.warn(`hirerDigest cache read: ${err.message}`);
    }
    const snapshot = await (0, exports.buildDigestSnapshot)(args.hirerProfileId);
    const noProvider = !(0, providers_1.isProviderEnabled)('groq') &&
        !(0, providers_1.isProviderEnabled)('gemini') &&
        !(0, providers_1.isProviderEnabled)('claude');
    if (noProvider || snapshot.totalJobsActive === 0) {
        const fallback = heuristicDigest(snapshot);
        const out = {
            ...fallback,
            generatedAt: new Date(),
            cached: false,
            usedAi: false,
            snapshot,
        };
        return out;
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq')
        ? 'groq'
        : undefined;
    const userPrompt = [
        `Active jobs: ${snapshot.totalJobsActive}`,
        `New applicants this week: ${snapshot.totalApplicationsThisWeek}`,
        `Shortlisted this week: ${snapshot.totalShortlistedThisWeek}`,
        'Per-job:',
        ...snapshot.jobs.map((j) => `- "${j.title}": ${j.newThisWeek} new, ${j.shortlisted} shortlisted, ${j.totalApplications} total, posted ${j.daysSincePosted}d ago`),
        'Return the JSON now.',
    ].join('\n');
    try {
        const parsed = await (0, providers_1.generateJson)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: userPrompt,
            json: true,
            maxTokens: 500,
            temperature: 0.4,
        }, { userId: args.userId, feature: 'hirer_digest' });
        const sane = sanitize(parsed) ?? heuristicDigest(snapshot);
        const out = {
            headline: sane.headline,
            bullets: sane.bullets,
            generatedAt: new Date(),
            cached: false,
            usedAi: true,
            snapshot,
        };
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24, JSON.stringify(out));
        }
        catch (err) {
            logger_1.logger.warn(`hirerDigest cache write: ${err.message}`);
        }
        return out;
    }
    catch (err) {
        logger_1.logger.warn(`hirerDigest failed: ${err.message}`);
        const fallback = heuristicDigest(snapshot);
        return {
            ...fallback,
            generatedAt: new Date(),
            cached: false,
            usedAi: false,
            snapshot,
        };
    }
};
exports.generateHirerDigest = generateHirerDigest;
