"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchJobsForUser = exports.aiMatch = exports.heuristicMatch = exports.toMatchable = void 0;
const constants_1 = require("../../config/constants");
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const completeness_service_1 = require("../profile/completeness.service");
const toMatchable = (j) => ({
    id: j._id.toString(),
    title: j.title,
    company: j.company,
    description: j.description,
    location: j.location,
    skills: j.skills,
    remoteType: j.remoteType,
    jobType: j.jobType,
    experienceMinYears: j.experienceMinYears,
    experienceMaxYears: j.experienceMaxYears,
    salaryMin: j.salaryMin,
    salaryMax: j.salaryMax,
});
exports.toMatchable = toMatchable;
const blendWithCompleteness = (rawScore, user) => {
    const profile = user.profile;
    const hasAnyProfileSignal = (profile?.skills?.length ?? 0) > 0 ||
        (profile?.preferredRoles?.length ?? 0) > 0 ||
        (profile?.experienceYears ?? 0) > 0 ||
        Boolean(profile?.resumeText) ||
        Boolean(profile?.resumeUrl) ||
        (profile?.resumeProfile?.employments?.length ?? 0) > 0 ||
        (profile?.resumeProfile?.itSkills?.length ?? 0) > 0;
    if (!hasAnyProfileSignal)
        return 0;
    const completeness = (0, completeness_service_1.completenessFromUser)(user);
    const factor = 0.6 + 0.4 * (completeness / 100);
    return Math.max(0, Math.min(100, Math.round(rawScore * factor)));
};
const cacheKey = (userId, jobId) => `match:${userId}:${jobId}`;
const heuristicMatch = (user, job) => {
    const userSkills = (user.profile.skills || []).map((s) => s.toLowerCase());
    const jobSkills = (job.skills || []).map((s) => s.toLowerCase());
    const desc = job.description.toLowerCase();
    const matched = userSkills.filter((s) => jobSkills.includes(s) || desc.includes(s));
    const missing = jobSkills.filter((s) => !userSkills.includes(s));
    let score = 0;
    if (jobSkills.length > 0) {
        score = (matched.length / jobSkills.length) * 50;
    }
    else if (userSkills.length > 0) {
        const overlap = userSkills.filter((s) => desc.includes(s)).length;
        score = (overlap / userSkills.length) * 50;
    }
    const userRoles = (user.profile.preferredRoles || []).map((r) => r.toLowerCase());
    if (userRoles.some((r) => job.title.toLowerCase().includes(r)))
        score += 15;
    const exp = user.profile.experienceYears ?? 0;
    const expMin = job.experienceMinYears;
    const expMax = job.experienceMaxYears;
    if (typeof expMin === 'number' || typeof expMax === 'number') {
        const lo = expMin ?? 0;
        const hi = expMax ?? Math.max(lo, exp);
        if (exp >= lo && exp <= hi) {
            score += 15;
        }
        else {
            const gap = exp < lo ? lo - exp : exp - hi;
            if (gap <= 2)
                score += 8;
            else if (gap <= 4)
                score += 3;
        }
    }
    const userLocs = (user.profile.preferredLocations || []).map((l) => l.toLowerCase());
    if (userLocs.some((l) => job.location.toLowerCase().includes(l) ||
        (l === 'remote' && job.remoteType === 'remote'))) {
        score += 10;
    }
    const expected = user.profile.expectedSalaryMin;
    const jobMin = job.salaryMin;
    const jobMax = job.salaryMax;
    if (typeof expected === 'number' && (typeof jobMin === 'number' || typeof jobMax === 'number')) {
        const offerHi = jobMax ?? jobMin ?? 0;
        const offerLo = jobMin ?? jobMax ?? 0;
        if (expected <= offerHi && expected >= offerLo * 0.9) {
            score += 5;
        }
        else if (offerHi >= expected) {
            score += 3;
        }
    }
    if (user.profile.preferredJobTypes?.length &&
        job.jobType &&
        user.profile.preferredJobTypes.includes(job.jobType)) {
        score += 3;
    }
    if (user.profile.preferredRemote?.length &&
        job.remoteType &&
        user.profile.preferredRemote.includes(job.remoteType)) {
        score += 2;
    }
    return {
        jobId: job.id,
        score: blendWithCompleteness(score, user),
        matchedSkills: matched,
        missingSkills: missing.slice(0, 5),
    };
};
exports.heuristicMatch = heuristicMatch;
const aiMatch = async (user, job) => {
    const cached = await redis_1.redis.get(cacheKey(user._id.toString(), job.id));
    if (cached)
        return JSON.parse(cached);
    if (!(0, providers_1.isAiEnabled)()) {
        const heuristic = (0, exports.heuristicMatch)(user, job);
        await redis_1.redis.setex(cacheKey(user._id.toString(), job.id), 86400, JSON.stringify(heuristic));
        return heuristic;
    }
    try {
        const profileText = `
Name: ${user.profile.fullName}
Headline: ${user.profile.headline || 'N/A'}
Experience: ${user.profile.experienceYears} years
Skills: ${(user.profile.skills || []).join(', ') || 'N/A'}
Preferred Roles: ${(user.profile.preferredRoles || []).join(', ') || 'N/A'}
Preferred Locations: ${(user.profile.preferredLocations || []).join(', ') || 'N/A'}
Preferred Job Types: ${(user.profile.preferredJobTypes || []).join(', ') || 'N/A'}
Resume Excerpt: ${(user.profile.resumeText || '').slice(0, 1500)}
`.trim();
        const jobText = `
Title: ${job.title}
Company: ${job.company}
Location: ${job.location} (${job.remoteType})
Job Type: ${job.jobType}
Required Skills: ${(job.skills || []).join(', ')}
Description: ${job.description.slice(0, 2000)}
`.trim();
        const parsed = await (0, providers_1.generateJson)({
            tier: 'lite',
            system: 'You are a career matching expert. Score how well a candidate matches a job from 0-100 based on skills, experience, role fit, and location. Return strict JSON only.',
            user: `Score the candidate-job match.

CANDIDATE PROFILE:
${profileText}

JOB:
${jobText}

Return JSON only with this exact shape:
{"score": <0-100>, "reasoning": "<one short sentence>", "matchedSkills": ["..."], "missingSkills": ["..."]}`,
            maxTokens: 400,
            temperature: 0.2,
        });
        if (!parsed)
            throw new Error('No JSON in response');
        const rawScore = Math.max(0, Math.min(100, Math.round(parsed.score)));
        const result = {
            jobId: job.id,
            score: blendWithCompleteness(rawScore, user),
            reasoning: parsed.reasoning,
            matchedSkills: parsed.matchedSkills || [],
            missingSkills: parsed.missingSkills || [],
        };
        await redis_1.redis.setex(cacheKey(user._id.toString(), job.id), 86400, JSON.stringify(result));
        return result;
    }
    catch (err) {
        logger_1.logger.warn('AI match failed, using heuristic fallback', err);
        return (0, exports.heuristicMatch)(user, job);
    }
};
exports.aiMatch = aiMatch;
const matchJobsForUser = async (user, jobs, threshold = constants_1.AI_MATCH_THRESHOLD, useAi = false) => {
    const matcher = useAi && (0, providers_1.isAiEnabled)()
        ? exports.aiMatch
        : async (u, j) => (0, exports.heuristicMatch)(u, j);
    const matched = [];
    const concurrency = useAi ? 5 : 50;
    for (let i = 0; i < jobs.length; i += concurrency) {
        const batch = jobs.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async (j) => ({ job: j, match: await matcher(user, j) })));
        for (const r of results) {
            if (r.match.score >= threshold)
                matched.push(r);
        }
    }
    matched.sort((a, b) => b.match.score - a.match.score);
    return matched;
};
exports.matchJobsForUser = matchJobsForUser;
