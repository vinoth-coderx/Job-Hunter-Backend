"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.draftRecruiterOutreach = exports.peekCachedOutreach = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const cacheKey = (jobId, candidateId, jobUpdatedAt) => {
    const hash = crypto_1.default
        .createHash('sha256')
        .update(`${jobId}|${candidateId}|${jobUpdatedAt.toISOString()}`)
        .digest('hex')
        .slice(0, 24);
    return `ai:outreach:${hash}`;
};
const SYSTEM_PROMPT = `You draft SHORT recruiter outreach messages a hirer can paste into an in-app chat with a candidate they want to recruit.

RULES:
- Output STRICT JSON: {"drafts": [{"label": "...", "body": "..."}, ...]}.
- Generate 2-3 variants. Each labelled with a short angle ("Direct", "Curious", "Mutual fit", "Project-led" — pick what fits).
- Each body: 50-110 words. Plain English. No recruiter clichés ("rockstar", "ninja", "exciting opportunity").
- Open by addressing the candidate by first name.
- Mention the SPECIFIC job title and one concrete reason their profile fits (cite a skill they have that the job needs, or a project relevant to the role).
- End with one clear next step ("open to a quick chat?", "want me to share the JD?").
- Don't promise compensation, equity, or specific interview rounds.
- Don't pretend to know things outside the input (no "I saw your LinkedIn", no fake mutual connections).
- Output ONLY the JSON, no markdown fences, no prose.`;
const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object')
        return [];
    const obj = raw;
    if (!Array.isArray(obj.drafts))
        return [];
    const out = [];
    for (const item of obj.drafts) {
        if (!item || typeof item !== 'object')
            continue;
        const r = item;
        const body = typeof r.body === 'string' ? r.body.trim().slice(0, 1500) : '';
        if (body.length < 30)
            continue;
        const label = typeof r.label === 'string' && r.label.trim().length > 0
            ? r.label.trim().slice(0, 30)
            : 'Draft';
        out.push({ label, body });
        if (out.length >= 3)
            break;
    }
    return out;
};
const fallback = (candidate, job) => {
    const firstName = (candidate.fullName || '').split(/\s+/)[0]?.trim() || 'there';
    return [
        {
            label: 'Direct',
            body: `Hi ${firstName} — I'm hiring for "${job.title}" and your background looks like a strong fit. ` +
                `Open to a quick chat about the role? Happy to share the JD if it sounds interesting.`,
        },
    ];
};
const peekCachedOutreach = async (jobId, candidateId, jobUpdatedAt) => {
    try {
        const raw = await redis_1.redis.get(cacheKey(jobId, candidateId, jobUpdatedAt));
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
exports.peekCachedOutreach = peekCachedOutreach;
const draftRecruiterOutreach = async (args) => {
    const { job, candidate, userId } = args;
    const ck = cacheKey(job._id.toString(), candidate._id.toString(), job.updatedAt);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            const parsed = JSON.parse(cached);
            return { drafts: parsed, usedAi: true, cached: true };
        }
    }
    catch (err) {
        logger_1.logger.warn(`outreach cache read: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq')
        ? 'groq'
        : undefined;
    if (!preferred &&
        !(0, providers_1.isProviderEnabled)('gemini')) {
        return {
            drafts: fallback(candidate.profile, job),
            usedAi: false,
            cached: false,
        };
    }
    const candidateBlock = [
        `Name: ${candidate.profile.fullName}`,
        candidate.profile.headline ? `Headline: ${candidate.profile.headline}` : null,
        candidate.profile.experienceYears
            ? `Experience: ${candidate.profile.experienceYears} year${candidate.profile.experienceYears === 1 ? '' : 's'}`
            : null,
        `Skills: ${(candidate.profile.skills ?? []).slice(0, 25).join(', ') || '(none listed)'}`,
    ]
        .filter(Boolean)
        .join('\n');
    const jobBlock = [
        `Title: ${job.title}`,
        `Required skills: ${(job.skills ?? []).slice(0, 25).join(', ') || '(none listed)'}`,
        `Location: ${job.location}`,
        `Description (excerpt): ${(job.description || '').slice(0, 1500)}`,
    ].join('\n');
    try {
        const parsed = await (0, providers_1.generateJson)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: `JOB\n${jobBlock}\n\nCANDIDATE\n${candidateBlock}\n\nReturn the JSON now.`,
            json: true,
            maxTokens: 800,
            temperature: 0.55,
        }, { userId, feature: 'recruiter_outreach' });
        const drafts = sanitize(parsed);
        if (drafts.length === 0) {
            return {
                drafts: fallback(candidate.profile, job),
                usedAi: false,
                cached: false,
            };
        }
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24, JSON.stringify(drafts));
        }
        catch (err) {
            logger_1.logger.warn(`outreach cache write: ${err.message}`);
        }
        return { drafts, usedAi: true, cached: false };
    }
    catch (err) {
        logger_1.logger.warn(`outreach draft failed: ${err.message}`);
        return {
            drafts: fallback(candidate.profile, job),
            usedAi: false,
            cached: false,
        };
    }
};
exports.draftRecruiterOutreach = draftRecruiterOutreach;
