"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.optimizeProfile = exports.invalidateProfileOptimizerCache = void 0;
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const cacheKey = (userId) => `profile-opt:${userId}`;
const invalidateProfileOptimizerCache = async (userId) => {
    await redis_1.redis.del(cacheKey(userId));
};
exports.invalidateProfileOptimizerCache = invalidateProfileOptimizerCache;
const profileBlock = (user) => {
    const p = user.profile;
    return [
        `Name: ${p.fullName}`,
        p.headline ? `Headline: ${p.headline}` : 'Headline: (missing)',
        `Experience: ${p.experienceYears} year${p.experienceYears === 1 ? '' : 's'}`,
        p.skills?.length ? `Skills (${p.skills.length}): ${p.skills.join(', ')}` : 'Skills: (none)',
        p.preferredRoles?.length
            ? `Preferred roles: ${p.preferredRoles.join(', ')}`
            : 'Preferred roles: (none)',
        p.preferredLocations?.length
            ? `Preferred locations: ${p.preferredLocations.join(', ')}`
            : 'Preferred locations: (none)',
        p.preferredJobTypes?.length
            ? `Preferred job types: ${p.preferredJobTypes.join(', ')}`
            : 'Preferred job types: (none)',
        p.expectedSalaryMin ? `Expected min salary: ₹${p.expectedSalaryMin}` : 'Expected salary: (not set)',
        p.resumeUrl || p.resumeFile ? 'Resume: uploaded' : 'Resume: (not uploaded)',
        p.resumeText ? `Resume text length: ${p.resumeText.length} chars` : 'Resume text: (not parsed)',
    ].join('\n');
};
const computeCompletenessScore = (user) => {
    const p = user.profile;
    let score = 0;
    if (p.fullName)
        score += 5;
    if (p.headline && p.headline.length >= 10)
        score += 10;
    if (p.experienceYears > 0)
        score += 5;
    if ((p.skills?.length ?? 0) >= 5)
        score += 20;
    else if ((p.skills?.length ?? 0) >= 1)
        score += 10;
    if ((p.preferredRoles?.length ?? 0) > 0)
        score += 10;
    if ((p.preferredLocations?.length ?? 0) > 0)
        score += 10;
    if ((p.preferredJobTypes?.length ?? 0) > 0)
        score += 5;
    if (p.expectedSalaryMin && p.expectedSalaryMin > 0)
        score += 5;
    if (p.resumeUrl || p.resumeFile)
        score += 20;
    if (p.resumeText && p.resumeText.length > 200)
        score += 10;
    return Math.max(0, Math.min(100, score));
};
const heuristicSuggestions = (user) => {
    const p = user.profile;
    const out = [];
    if (!p.headline || p.headline.length < 10) {
        out.push({
            field: 'headline',
            priority: 'high',
            title: 'Add a clear headline',
            description: 'A 1-line headline (role + 2 specialties) is the first thing hirers see when scanning applicants.',
        });
    }
    if ((p.skills?.length ?? 0) < 5) {
        out.push({
            field: 'skills',
            priority: 'high',
            title: 'Add more skills',
            description: 'Profiles with 5–10 well-chosen skills get matched to ~3× more jobs by our matcher.',
        });
    }
    if (!p.resumeUrl && !p.resumeFile) {
        out.push({
            field: 'resume',
            priority: 'high',
            title: 'Upload a resume',
            description: 'You can\'t auto-apply or one-click apply to native jobs without a resume on file.',
        });
    }
    if ((p.preferredRoles?.length ?? 0) === 0) {
        out.push({
            field: 'preferredRoles',
            priority: 'medium',
            title: 'Set preferred roles',
            description: 'Helps the matcher understand which job titles to prioritise and is required for Auto-Apply.',
        });
    }
    if ((p.preferredLocations?.length ?? 0) === 0) {
        out.push({
            field: 'preferredLocations',
            priority: 'medium',
            title: 'Pick preferred cities',
            description: 'Adds location-fit weight to your match score and unlocks the "Jobs near me" home section.',
        });
    }
    if (!p.expectedSalaryMin) {
        out.push({
            field: 'expectedSalary',
            priority: 'low',
            title: 'Set a minimum salary',
            description: 'Lets Auto-Apply skip listings below your floor so your applications stay on-target.',
        });
    }
    return out;
};
const optimizeProfile = async (user, opts = {}) => {
    const id = user._id.toString();
    if (!opts.forceRefresh) {
        const cached = await redis_1.redis.get(cacheKey(id));
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch {
            }
        }
    }
    const completenessScore = computeCompletenessScore(user);
    const heuristics = heuristicSuggestions(user);
    if (!(0, providers_1.isAiEnabled)()) {
        const result = {
            completenessScore,
            suggestions: heuristics,
            usedAi: false,
            generatedAt: new Date(),
        };
        await redis_1.redis.setex(cacheKey(id), 60 * 60 * 6, JSON.stringify(result));
        return result;
    }
    const system = `You are a career coach helping job seekers fix their profile. Output strict JSON:
{
  "suggestions": [
    {
      "field": "headline" | "skills" | "experience" | "preferredRoles" | "preferredLocations" | "expectedSalary" | "resume" | "general",
      "priority": "high" | "medium" | "low",
      "title": "Short imperative title (3–8 words)",
      "description": "1–2 sentences explaining why this matters and what to do.",
      "suggestedValue": "(optional) concrete suggested text or array of items"
    }
  ]
}

Rules:
- Output ONLY JSON, no prose, no markdown fences.
- 3–6 suggestions, ordered most-impactful first.
- Be specific and actionable; never use the word "consider".
- Don't invent data the candidate didn't share. If the profile is sparse, suggest filling sections.
- If the candidate already has a section well-filled, don't suggest re-doing it.`;
    const prompt = `Candidate profile:
${profileBlock(user)}

Generate suggestions now.`;
    try {
        const parsed = await (0, providers_1.generateJson)({
            tier: 'lite',
            system: opts.forceRefresh
                ? `${system}\n\nIMPORTANT: This is a re-analysis. Surface ANGLES and SPECIFIC SUGGESTIONS that differ from a typical first pass — pick less-obvious gaps, novel phrasings, or sections you'd usually mention second.`
                : system,
            user: prompt,
            maxTokens: 900,
            temperature: opts.forceRefresh ? 0.85 : 0.4,
        });
        let suggestions = [];
        if (parsed) {
            const arr = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
            suggestions = arr
                .filter((x) => typeof x === 'object' && x !== null)
                .slice(0, 8)
                .map((x) => ({
                field: ([
                    'headline',
                    'skills',
                    'experience',
                    'preferredRoles',
                    'preferredLocations',
                    'expectedSalary',
                    'resume',
                    'general',
                ].includes(x.field)
                    ? x.field
                    : 'general'),
                priority: (['high', 'medium', 'low'].includes(x.priority)
                    ? x.priority
                    : 'medium'),
                title: String(x.title ?? '').slice(0, 100),
                description: String(x.description ?? '').slice(0, 600),
                suggestedValue: Array.isArray(x.suggestedValue)
                    ? x.suggestedValue.map(String).slice(0, 20)
                    : typeof x.suggestedValue === 'string'
                        ? x.suggestedValue.slice(0, 600)
                        : undefined,
            }))
                .filter((s) => s.title.length >= 3);
        }
        if (suggestions.length === 0)
            suggestions = heuristics;
        const result = {
            completenessScore,
            suggestions,
            usedAi: true,
            generatedAt: new Date(),
        };
        await redis_1.redis.setex(cacheKey(id), 60 * 60 * 24, JSON.stringify(result));
        return result;
    }
    catch (err) {
        logger_1.logger.warn(`profileOptimizer failed: ${err.message}`);
        return {
            completenessScore,
            suggestions: heuristics,
            usedAi: false,
            generatedAt: new Date(),
        };
    }
};
exports.optimizeProfile = optimizeProfile;
