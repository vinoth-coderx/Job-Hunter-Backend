"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchJobsForUser = exports.aiMatch = exports.heuristicMatch = void 0;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const env_1 = require("../../config/env");
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const client = env_1.env.ANTHROPIC_API_KEY
    ? new sdk_1.default({ apiKey: env_1.env.ANTHROPIC_API_KEY })
    : null;
const MODEL = 'claude-haiku-4-5-20251001';
const cacheKey = (userId, jobId) => `match:${userId}:${jobId}`;
const heuristicMatch = (user, job) => {
    const userSkills = (user.profile.skills || []).map((s) => s.toLowerCase());
    const jobSkills = (job.skills || []).map((s) => s.toLowerCase());
    const desc = job.description.toLowerCase();
    const matched = userSkills.filter((s) => jobSkills.includes(s) || desc.includes(s));
    const missing = jobSkills.filter((s) => !userSkills.includes(s));
    let score = 0;
    if (jobSkills.length > 0) {
        score = (matched.length / jobSkills.length) * 70;
    }
    else if (userSkills.length > 0) {
        const overlap = userSkills.filter((s) => desc.includes(s)).length;
        score = (overlap / userSkills.length) * 70;
    }
    const userRoles = (user.profile.preferredRoles || []).map((r) => r.toLowerCase());
    if (userRoles.some((r) => job.title.toLowerCase().includes(r)))
        score += 15;
    const userLocs = (user.profile.preferredLocations || []).map((l) => l.toLowerCase());
    if (userLocs.some((l) => job.location.toLowerCase().includes(l) || (l === 'remote' && job.remoteType === 'remote'))) {
        score += 10;
    }
    if (user.profile.preferredJobTypes?.length &&
        user.profile.preferredJobTypes.includes(job.jobType)) {
        score += 5;
    }
    return {
        jobId: job._id.toString(),
        score: Math.min(100, Math.round(score)),
        matchedSkills: matched,
        missingSkills: missing.slice(0, 5),
    };
};
exports.heuristicMatch = heuristicMatch;
const aiMatch = async (user, job) => {
    const cached = await redis_1.redis.get(cacheKey(user._id.toString(), job._id.toString()));
    if (cached)
        return JSON.parse(cached);
    if (!client) {
        const heuristic = (0, exports.heuristicMatch)(user, job);
        await redis_1.redis.setex(cacheKey(user._id.toString(), job._id.toString()), 86400, JSON.stringify(heuristic));
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
        const response = await client.beta.messages.create({
            model: MODEL,
            max_tokens: 400,
            system: [
                {
                    type: 'text',
                    text: 'You are a career matching expert. Score how well a candidate matches a job from 0-100 based on skills, experience, role fit, and location. Return strict JSON only.',
                    cache_control: { type: 'ephemeral' },
                },
            ],
            messages: [
                {
                    role: 'user',
                    content: `Score the candidate-job match.

CANDIDATE PROFILE:
${profileText}

JOB:
${jobText}

Return JSON only with this exact shape:
{"score": <0-100>, "reasoning": "<one short sentence>", "matchedSkills": ["..."], "missingSkills": ["..."]}`,
                },
            ],
        });
        const block = response.content[0];
        const text = block.type === 'text' ? block.text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch)
            throw new Error('No JSON in response');
        const parsed = JSON.parse(jsonMatch[0]);
        const result = {
            jobId: job._id.toString(),
            score: Math.max(0, Math.min(100, Math.round(parsed.score))),
            reasoning: parsed.reasoning,
            matchedSkills: parsed.matchedSkills || [],
            missingSkills: parsed.missingSkills || [],
        };
        await redis_1.redis.setex(cacheKey(user._id.toString(), job._id.toString()), 86400, JSON.stringify(result));
        return result;
    }
    catch (err) {
        logger_1.logger.warn('AI match failed, using heuristic fallback', err);
        return (0, exports.heuristicMatch)(user, job);
    }
};
exports.aiMatch = aiMatch;
const matchJobsForUser = async (user, jobs, threshold = env_1.env.AI_MATCH_THRESHOLD, useAi = false) => {
    const matcher = useAi && client ? exports.aiMatch : async (u, j) => (0, exports.heuristicMatch)(u, j);
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
