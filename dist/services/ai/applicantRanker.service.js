"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rankApplicants = exports.peekCachedRanking = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const cacheKey = (jobId, jobUpdatedAt, applicationIds) => {
    const sorted = [...applicationIds].sort().join(',');
    const hash = crypto_1.default
        .createHash('sha256')
        .update(`${jobId}|${jobUpdatedAt.toISOString()}|${sorted}`)
        .digest('hex')
        .slice(0, 24);
    return `ai:rank:${hash}`;
};
const SYSTEM_PROMPT = `You are a senior recruiter ranking candidates for a job. Score each candidate 0-100 on fit, then list 1-3 strengths and 1-3 concerns. Output STRICT JSON only.

Score guide:
- 90+ : exceptional fit, strong yes
- 75-89: solid fit, recommend interview
- 60-74: marginal fit, depends on pipeline
- 40-59: weak fit, only if pipeline is dry
- <40 : poor fit

Rules:
- Be specific: cite actual skills/experience the candidate has, not generic platitudes.
- Concerns must be evidence-based (e.g. "no listed experience with X" — not "may not be a culture fit").
- Don't invent details the candidate didn't list.
- Order the output array by aiScore descending.

Schema:
{
  "rankings": [
    {
      "applicationId": "string from input",
      "aiScore": number (0-100),
      "summary": "one-sentence verdict, 12-20 words",
      "strengths": ["short bullets, 5-12 words each, max 3"],
      "concerns": ["short bullets, 5-12 words each, max 3"]
    }
  ]
}

Output ONLY the JSON, no markdown fences, no prose.`;
const buildUserPrompt = (job, applicants) => {
    const jobBlock = [
        `Title: ${job.title}`,
        `Required skills: ${(job.skills ?? []).slice(0, 30).join(', ') || '(none listed)'}`,
        `Description: ${(job.description || '').slice(0, 3000)}`,
    ].join('\n');
    const applicantBlocks = applicants
        .map((a, i) => {
        const skills = a.skills.slice(0, 20).join(', ') || '(none)';
        const resume = (a.resumeText || '').slice(0, 1200);
        return [
            `Candidate ${i + 1} (applicationId="${a.applicationId}"):`,
            `Name: ${a.fullName}`,
            a.headline ? `Headline: ${a.headline}` : null,
            a.experienceYears !== undefined
                ? `Experience: ${a.experienceYears} year${a.experienceYears === 1 ? '' : 's'}`
                : null,
            `Skills: ${skills}`,
            a.heuristicMatch !== undefined
                ? `(prior heuristic match: ${a.heuristicMatch})`
                : null,
            resume ? `Resume excerpt: ${resume}` : '(no resume text on file)',
        ]
            .filter(Boolean)
            .join('\n');
    })
        .join('\n\n');
    return `JOB
${jobBlock}

CANDIDATES (${applicants.length})
${applicantBlocks}

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
    if (!parsed?.rankings || !Array.isArray(parsed.rankings))
        return [];
    const seen = new Set();
    const cleaned = [];
    for (const r of parsed.rankings) {
        const id = asString(r.applicationId, 30);
        if (!id || !validIds.has(id) || seen.has(id))
            continue;
        const score = typeof r.aiScore === 'number' && Number.isFinite(r.aiScore)
            ? Math.max(0, Math.min(100, Math.round(r.aiScore)))
            : 0;
        cleaned.push({
            applicationId: id,
            aiScore: score,
            rank: 0,
            summary: asString(r.summary, 240),
            strengths: asStringArray(r.strengths),
            concerns: asStringArray(r.concerns),
        });
        seen.add(id);
    }
    cleaned.sort((a, b) => b.aiScore - a.aiScore);
    return cleaned.map((r, i) => ({ ...r, rank: i + 1 }));
};
const heuristicRank = (job, applicants) => {
    const jobSkills = (job.skills ?? []).map((s) => s.toLowerCase());
    const scored = applicants.map((a) => {
        const aSkills = new Set(a.skills.map((s) => s.toLowerCase()));
        const overlap = jobSkills.filter((s) => aSkills.has(s)).length;
        const fromOverlap = jobSkills.length
            ? Math.round((overlap / jobSkills.length) * 100)
            : 0;
        const score = a.heuristicMatch ?? fromOverlap;
        return {
            applicationId: a.applicationId,
            aiScore: score,
            rank: 0,
            summary: '',
            strengths: [],
            concerns: [],
        };
    });
    scored.sort((a, b) => b.aiScore - a.aiScore);
    return scored.map((r, i) => ({ ...r, rank: i + 1 }));
};
const peekCachedRanking = async (jobId, jobUpdatedAt, applicationIds) => {
    if (applicationIds.length === 0)
        return null;
    try {
        const raw = await redis_1.redis.get(cacheKey(jobId, jobUpdatedAt, applicationIds));
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
exports.peekCachedRanking = peekCachedRanking;
const rankApplicants = async (args) => {
    const { job, applicants, userId } = args;
    const ids = applicants.map((a) => a.applicationId);
    const validIds = new Set(ids);
    if (applicants.length === 0) {
        return {
            rankings: [],
            usedAi: false,
            cached: false,
            generatedAt: new Date(),
        };
    }
    const ck = cacheKey(job._id.toString(), job.updatedAt, ids);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            return {
                rankings: JSON.parse(cached),
                usedAi: true,
                cached: true,
                generatedAt: new Date(),
            };
        }
    }
    catch (err) {
        logger_1.logger.warn(`applicantRanker cache read failed: ${err.message}`);
    }
    if (!(0, providers_1.isAiEnabled)()) {
        const fallback = heuristicRank(job, applicants);
        return {
            rankings: fallback,
            usedAi: false,
            cached: false,
            generatedAt: new Date(),
        };
    }
    try {
        const parsed = await (0, providers_1.generateJson)({
            tier: 'smart',
            system: SYSTEM_PROMPT,
            user: buildUserPrompt(job, applicants),
            maxTokens: 2000,
            temperature: 0.3,
        }, { userId, feature: 'applicant_rank' });
        const rankings = sanitize(parsed, validIds);
        if (rankings.length === 0) {
            return {
                rankings: heuristicRank(job, applicants),
                usedAi: false,
                cached: false,
                generatedAt: new Date(),
            };
        }
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 6, JSON.stringify(rankings));
        }
        catch (err) {
            logger_1.logger.warn(`applicantRanker cache write failed: ${err.message}`);
        }
        return {
            rankings,
            usedAi: true,
            cached: false,
            generatedAt: new Date(),
        };
    }
    catch (err) {
        logger_1.logger.warn(`applicantRanker failed: ${err.message}`);
        return {
            rankings: heuristicRank(job, applicants),
            usedAi: false,
            cached: false,
            generatedAt: new Date(),
        };
    }
};
exports.rankApplicants = rankApplicants;
