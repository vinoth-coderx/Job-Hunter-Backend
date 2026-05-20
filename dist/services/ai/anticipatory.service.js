"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasForYouCached = exports.getForYouRecommendations = void 0;
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const Job_1 = require("../../models/Job");
const JobView_1 = require("../../models/JobView");
const SavedJob_1 = require("../../models/SavedJob");
const AppliedJob_1 = require("../../models/AppliedJob");
const constants_1 = require("../../config/constants");
const providers_1 = require("./providers");
const CACHE_TTL_SEC = 30 * 60;
const CACHE_KEY = (uid) => `ai:foryou:${uid}`;
const getRecentSignals = async (userId) => {
    const [viewDocs, savedDocs, appliedDocs] = await Promise.all([
        JobView_1.JobView.find({ user: userId })
            .sort({ viewedAt: -1 })
            .limit(10)
            .populate('job', 'title company location remoteType skills jobType')
            .lean(),
        SavedJob_1.SavedJob.find({ user: userId })
            .sort({ savedAt: -1 })
            .limit(10)
            .populate('job', 'title company')
            .lean(),
        AppliedJob_1.AppliedJob.find({ user: userId })
            .sort({ appliedAt: -1 })
            .limit(10)
            .populate('job', 'title company')
            .lean(),
    ]);
    return {
        viewedJobs: viewDocs.map((v) => v.job).filter(Boolean),
        savedTitles: savedDocs.map((s) => (s.job ? `${s.job.title} @ ${s.job.company}` : '')).filter(Boolean),
        appliedTitles: appliedDocs.map((a) => (a.job ? `${a.job.title} @ ${a.job.company}` : '')).filter(Boolean),
    };
};
const compactJobLine = (j) => `id:${j._id.toString()} | ${j.title} @ ${j.company} | ${j.location} (${j.remoteType}) | ${j.jobType} | skills: ${(j.skills || []).slice(0, 8).join(', ')}`;
const SYSTEM_PROMPT = `You are an anticipatory career assistant. From a candidate's profile + their recent app activity (jobs viewed, saved, applied), you spot what they're REALLY hunting for and pick the 3 best fresh jobs from the available pool. Output STRICT JSON, no prose.

Schema:
{
  "insight": "<one sentence: what we noticed about their search pattern>",
  "picks": [
    {
      "jobId": "<exact id from input pool>",
      "title": "<job title>",
      "company": "<company>",
      "whyThisJob": "<one sentence tying this pick to their recent activity>",
      "matchSignals": ["short reason 1", "short reason 2"]
    }
  ]
}

Rules:
- picks MUST be exactly 3 items.
- jobId MUST be from the input pool — never invent.
- whyThisJob ties to recent activity ("you saved 3 Flutter roles", "you applied to similar remote backend jobs").
- If recent activity is empty, base picks on profile preferences and say so in insight.
- Skip the recommendation entirely (return empty picks) if no fresh jobs at all.`;
const getForYouRecommendations = async (user, opts = {}) => {
    const userId = String(user._id);
    const cacheKey = CACHE_KEY(userId);
    if (!opts.forceRefresh) {
        const cached = await redis_1.redis.get(cacheKey);
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch {
            }
        }
    }
    const signals = await getRecentSignals(userId);
    const sinceMs = Date.now() - constants_1.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
    const pool = await Job_1.Job.find({
        status: 'active',
        postedAt: { $gte: new Date(sinceMs) },
    })
        .sort({ postedAt: -1 })
        .limit(40)
        .lean();
    if (pool.length === 0) {
        logger_1.logger.info('getForYouRecommendations: empty job pool, returning null');
        return null;
    }
    const profileBlock = [
        `Name: ${user.profile.fullName || 'Unknown'}`,
        `Headline: ${user.profile.headline || 'N/A'}`,
        `Skills: ${(user.profile.skills || []).slice(0, 30).join(', ') || 'N/A'}`,
        `Preferred Roles: ${(user.profile.preferredRoles || []).join(', ') || 'N/A'}`,
        `Preferred Locations: ${(user.profile.preferredLocations || []).join(', ') || 'N/A'}`,
        `Experience: ${user.profile.experienceYears ?? 0} years`,
    ].join('\n');
    const recentBlock = [
        `Recently viewed (${signals.viewedJobs.length}):`,
        signals.viewedJobs.map((j) => `- ${j.title} @ ${j.company} (${j.location})`).join('\n') || '  (none)',
        `Saved: ${signals.savedTitles.join('; ') || '(none)'}`,
        `Applied: ${signals.appliedTitles.join('; ') || '(none)'}`,
    ].join('\n');
    const poolBlock = pool.map((j) => compactJobLine(j)).join('\n');
    const userPrompt = `CANDIDATE PROFILE:
${profileBlock}

RECENT ACTIVITY:
${recentBlock}

AVAILABLE JOB POOL (${pool.length}):
${poolBlock}

Return the JSON now.`;
    const result = await (0, providers_1.generateJson)({
        tier: 'smart',
        system: SYSTEM_PROMPT,
        user: userPrompt,
        maxTokens: 1500,
        temperature: 0.4,
    });
    if (!result)
        return null;
    const validIds = new Set(pool.map((j) => j._id.toString()));
    const picksIn = Array.isArray(result.picks) ? result.picks : [];
    const picks = picksIn
        .filter((p) => !!p && typeof p === 'object')
        .filter((p) => validIds.has(p.jobId))
        .map((p) => ({
        jobId: p.jobId,
        title: String(p.title || '').slice(0, 200),
        company: String(p.company || '').slice(0, 200),
        whyThisJob: String(p.whyThisJob || '').slice(0, 300),
        matchSignals: Array.isArray(p.matchSignals)
            ? p.matchSignals.map((s) => String(s).slice(0, 80)).filter(Boolean).slice(0, 4)
            : [],
    }))
        .slice(0, 3);
    const now = new Date();
    const out = {
        insight: String(result.insight || '').slice(0, 400),
        picks,
        cachedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CACHE_TTL_SEC * 1000).toISOString(),
    };
    try {
        await redis_1.redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(out));
    }
    catch (err) {
        logger_1.logger.warn(`for-you cache persist failed: ${err.message}`);
    }
    return out;
};
exports.getForYouRecommendations = getForYouRecommendations;
const hasForYouCached = async (userId) => {
    const exists = await redis_1.redis.exists(CACHE_KEY(userId));
    return exists === 1;
};
exports.hasForYouCached = hasForYouCached;
