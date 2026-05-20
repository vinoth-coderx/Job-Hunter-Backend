"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyseSkillGap = void 0;
const logger_1 = require("../../utils/logger");
const Job_1 = require("../../models/Job");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const cacheKey = (userId, role, city) => `skill-gap:${userId}:${role.toLowerCase()}:${(city ?? '').toLowerCase()}`;
const analyseSkillGap = async (user, role, city) => {
    const id = user._id.toString();
    const ck = cacheKey(id, role, city);
    const cached = await redis_1.redis.get(ck);
    if (cached) {
        try {
            return JSON.parse(cached);
        }
        catch {
        }
    }
    const filter = {
        isActive: true,
        title: { $regex: role, $options: 'i' },
    };
    if (city && city.length > 0) {
        filter.location = { $regex: city, $options: 'i' };
    }
    const jobs = await Job_1.Job.find(filter).select('skills title').limit(500).lean();
    const tally = new Map();
    for (const j of jobs) {
        for (const raw of j.skills ?? []) {
            const s = (raw || '').toLowerCase().trim();
            if (!s)
                continue;
            tally.set(s, (tally.get(s) ?? 0) + 1);
        }
    }
    const userSkills = new Set((user.profile.skills ?? []).map((s) => s.toLowerCase().trim()));
    const ranked = [...tally.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25);
    const totalJobsForDenom = jobs.length || 1;
    const matched = [];
    const missing = [];
    for (const [s, count] of ranked) {
        const pct = Math.round((count / totalJobsForDenom) * 100);
        if (userSkills.has(s)) {
            matched.push({ skill: s, demandPercent: pct });
        }
        else {
            missing.push({ skill: s, demandPercent: pct });
        }
    }
    const totalDemand = ranked.reduce((sum, [, n]) => sum + n, 0);
    const matchedDemand = ranked
        .filter(([s]) => userSkills.has(s))
        .reduce((sum, [, n]) => sum + n, 0);
    const readinessScore = totalDemand > 0 ? Math.round((matchedDemand / totalDemand) * 100) : 0;
    let resources = [];
    let usedAi = false;
    if ((0, providers_1.isAiEnabled)() && missing.length > 0) {
        try {
            const top = missing.slice(0, 6).map((m) => m.skill);
            const system = `Suggest concise learning resources to fill skill gaps for a Job seeker. Output strict JSON:
{"resources":[
  {"skill":"...","title":"...","type":"course"|"book"|"tutorial"|"project","url":"https://..." (optional),"estimatedHours":number (optional)}
]}
Rules: ONLY JSON, no prose. Up to 2 resources per skill, max 12 total. Prefer free / well-known options. URLs must be real (skip if unsure).`;
            const userPrompt = `Skills to fill: ${top.join(', ')}\nTarget role: ${role}\nCandidate experience: ${user.profile.experienceYears} years.`;
            const parsed = await (0, providers_1.generateJson)({
                tier: 'lite',
                system,
                user: userPrompt,
                maxTokens: 900,
                temperature: 0.4,
            });
            if (parsed) {
                const arr = Array.isArray(parsed.resources) ? parsed.resources : [];
                resources = arr
                    .filter((x) => typeof x === 'object' && x !== null)
                    .slice(0, 12)
                    .map((x) => ({
                    skill: String(x.skill ?? '').toLowerCase().slice(0, 100),
                    title: String(x.title ?? '').slice(0, 200),
                    type: (['course', 'book', 'tutorial', 'project'].includes(x.type)
                        ? x.type
                        : 'course'),
                    url: typeof x.url === 'string' ? x.url.slice(0, 500) : undefined,
                    estimatedHours: typeof x.estimatedHours === 'number'
                        ? Math.max(1, Math.min(500, Math.round(x.estimatedHours)))
                        : undefined,
                }))
                    .filter((r) => r.skill.length > 0 && r.title.length > 2);
                usedAi = true;
            }
        }
        catch (err) {
            logger_1.logger.warn(`skillGap LLM failed: ${err.message}`);
        }
    }
    const result = {
        role,
        city,
        jobsAnalyzed: jobs.length,
        matchedSkills: matched,
        missingSkills: missing,
        resources,
        readinessScore,
        usedAi,
    };
    await redis_1.redis.setex(ck, 60 * 60 * 12, JSON.stringify(result));
    return result;
};
exports.analyseSkillGap = analyseSkillGap;
