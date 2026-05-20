"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestCandidates = exports.peekCachedSuggestions = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const cacheKey = (jobId, jobUpdatedAt, userIds) => {
    const sorted = [...userIds].sort().join(',');
    const hash = crypto_1.default
        .createHash('sha256')
        .update(`${jobId}|${jobUpdatedAt.toISOString()}|${sorted}`)
        .digest('hex')
        .slice(0, 24);
    return `ai:csugg:${hash}`;
};
const SYSTEM_PROMPT = `You're a senior recruiter scanning a candidate pool for fit against a specific job. Score each candidate 0-100 and explain the recommendation in one sentence + bullets.

Score guide:
- 90+: exceptional fit, reach out today
- 75-89: strong fit, worth a recruiter ping
- 60-74: marginal, only if pipeline is thin
- 40-59: weak, skip
- <40: not a fit

Rules:
- Order output by score descending.
- Be specific: cite the candidate's actual skills/experience that match the job's requirements.
- Concerns must be evidence-based ("no listed AWS experience" — not "may not be senior enough").
- Don't invent details the candidate didn't list.
- If a candidate is below 40, omit them from the output entirely — only surface real fits.

Output STRICT JSON:
{
  "suggestions": [
    {
      "userId": "string from input",
      "score": number (40-100),
      "summary": "one-sentence verdict, 12-20 words",
      "strengths": ["short bullets, 5-12 words each, max 3"],
      "concerns": ["short bullets, 5-12 words each, max 3"]
    }
  ]
}

Output ONLY the JSON, no markdown fences, no prose.`;
const buildUserPrompt = (job, pool) => {
    const jobBlock = [
        `Title: ${job.title}`,
        `Required skills: ${(job.skills ?? []).slice(0, 30).join(', ') || '(none listed)'}`,
        `Description: ${(job.description || '').slice(0, 3000)}`,
    ].join('\n');
    const candidates = pool
        .map((c, i) => {
        const skills = c.skills.slice(0, 20).join(', ') || '(none)';
        const resume = (c.resumeText || '').slice(0, 1200);
        return [
            `Candidate ${i + 1} (userId="${c.userId}"):`,
            `Name: ${c.fullName}`,
            c.headline ? `Headline: ${c.headline}` : null,
            c.experienceYears !== undefined
                ? `Experience: ${c.experienceYears} year${c.experienceYears === 1 ? '' : 's'}`
                : null,
            `Skills: ${skills}`,
            c.lastSeenAt ? `Last applied: ${c.lastSeenAt}` : null,
            resume ? `Resume excerpt: ${resume}` : '(no resume on file)',
        ]
            .filter(Boolean)
            .join('\n');
    })
        .join('\n\n');
    return `JOB
${jobBlock}

CANDIDATE POOL (${pool.length})
${candidates}

Return the JSON now.`;
};
const asString = (v, max = 240) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const asStringArray = (v, max = 3, itemMax = 80) => {
    if (!Array.isArray(v))
        return [];
    return v
        .map((x) => asString(x, itemMax))
        .filter((s) => s.length > 0)
        .slice(0, max);
};
const sanitize = (parsed, validIds) => {
    if (!parsed?.suggestions || !Array.isArray(parsed.suggestions))
        return [];
    const seen = new Set();
    const out = [];
    for (const r of parsed.suggestions) {
        const id = asString(r.userId, 30);
        if (!id || !validIds.has(id) || seen.has(id))
            continue;
        const score = typeof r.score === 'number' && Number.isFinite(r.score)
            ? Math.max(0, Math.min(100, Math.round(r.score)))
            : 0;
        if (score < 40)
            continue;
        out.push({
            userId: id,
            score,
            rank: 0,
            summary: asString(r.summary, 240),
            strengths: asStringArray(r.strengths),
            concerns: asStringArray(r.concerns),
        });
        seen.add(id);
    }
    out.sort((a, b) => b.score - a.score);
    return out.map((s, i) => ({ ...s, rank: i + 1 }));
};
const heuristicSuggest = (job, pool) => {
    const jobSkills = new Set((job.skills ?? []).map((s) => s.toLowerCase()));
    if (jobSkills.size === 0)
        return [];
    const scored = pool
        .map((c) => {
        const candSkills = c.skills.map((s) => s.toLowerCase());
        const overlap = candSkills.filter((s) => jobSkills.has(s)).length;
        const score = Math.round((overlap / jobSkills.size) * 100);
        return { c, score };
    })
        .filter((x) => x.score >= 40);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 10).map(({ c, score }, i) => ({
        userId: c.userId,
        score,
        rank: i + 1,
        summary: '',
        strengths: [],
        concerns: [],
    }));
};
const peekCachedSuggestions = async (jobId, jobUpdatedAt, userIds) => {
    if (userIds.length === 0)
        return null;
    try {
        const raw = await redis_1.redis.get(cacheKey(jobId, jobUpdatedAt, userIds));
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
exports.peekCachedSuggestions = peekCachedSuggestions;
const suggestCandidates = async (args) => {
    const { job, pool, userId } = args;
    const limit = Math.max(1, Math.min(20, args.limit ?? 10));
    const validIds = new Set(pool.map((c) => c.userId));
    if (pool.length === 0) {
        return {
            suggestions: [],
            usedAi: false,
            cached: false,
            poolSize: 0,
            generatedAt: new Date(),
        };
    }
    const ids = pool.map((c) => c.userId);
    const ck = cacheKey(job._id.toString(), job.updatedAt, ids);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            const parsed = JSON.parse(cached);
            return {
                suggestions: parsed.slice(0, limit),
                usedAi: true,
                cached: true,
                poolSize: pool.length,
                generatedAt: new Date(),
            };
        }
    }
    catch (err) {
        logger_1.logger.warn(`candidateSuggester cache read failed: ${err.message}`);
    }
    if (!(0, providers_1.isAiEnabled)()) {
        return {
            suggestions: heuristicSuggest(job, pool).slice(0, limit),
            usedAi: false,
            cached: false,
            poolSize: pool.length,
            generatedAt: new Date(),
        };
    }
    try {
        const parsed = await (0, providers_1.generateJson)({
            tier: 'smart',
            system: SYSTEM_PROMPT,
            user: buildUserPrompt(job, pool),
            maxTokens: 2000,
            temperature: 0.3,
        }, { userId, feature: 'candidate_suggest' });
        const suggestions = sanitize(parsed, validIds);
        if (suggestions.length === 0) {
            return {
                suggestions: heuristicSuggest(job, pool).slice(0, limit),
                usedAi: false,
                cached: false,
                poolSize: pool.length,
                generatedAt: new Date(),
            };
        }
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 6, JSON.stringify(suggestions));
        }
        catch (err) {
            logger_1.logger.warn(`candidateSuggester cache write failed: ${err.message}`);
        }
        return {
            suggestions: suggestions.slice(0, limit),
            usedAi: true,
            cached: false,
            poolSize: pool.length,
            generatedAt: new Date(),
        };
    }
    catch (err) {
        logger_1.logger.warn(`candidateSuggester failed: ${err.message}`);
        return {
            suggestions: heuristicSuggest(job, pool).slice(0, limit),
            usedAi: false,
            cached: false,
            poolSize: pool.length,
            generatedAt: new Date(),
        };
    }
};
exports.suggestCandidates = suggestCandidates;
