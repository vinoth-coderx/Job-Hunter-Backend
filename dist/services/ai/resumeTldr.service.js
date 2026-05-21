"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.peekCachedTldr = exports.summariseResume = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const promptGuard_service_1 = require("./promptGuard.service");
const cacheKey = (resumeText) => {
    const hash = crypto_1.default
        .createHash('sha256')
        .update(resumeText.trim().toLowerCase().slice(0, 12000))
        .digest('hex')
        .slice(0, 24);
    return `ai:tldr:${hash}`;
};
const SYSTEM_PROMPT = `You write a 2-line TL;DR of a candidate's resume for a busy recruiter. RULES:

- Output STRICT JSON: {"summary": "...", "strengths": ["...", "..."], "yearsOfExperience": 4, "topRoles": ["..."]}.
- "summary": exactly 2 sentences. First sentence: who they are (role + experience + standout context). Second sentence: what they're best at + any signal of trajectory.
- "strengths": 3-5 short bullets (4-10 words each), each citing a SPECIFIC capability the resume actually shows. NEVER invent.
- "yearsOfExperience": integer; infer from employment history if not stated. Null when truly unclear.
- "topRoles": 1-3 most-recent job titles (verbatim from resume).
- Don't invent skills, companies, or years.
- Don't editorialize ("impressive candidate", "would be great"). State facts.
- Output ONLY the JSON, no markdown fences, no prose.`;
const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object')
        return null;
    const obj = raw;
    const summary = typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 600) : '';
    if (summary.length < 20)
        return null;
    const strengths = Array.isArray(obj.strengths)
        ? obj.strengths
            .map((s) => (typeof s === 'string' ? s.trim().slice(0, 140) : ''))
            .filter((s) => s.length >= 4)
            .slice(0, 5)
        : [];
    const years = typeof obj.yearsOfExperience === 'number' &&
        Number.isFinite(obj.yearsOfExperience) &&
        obj.yearsOfExperience >= 0 &&
        obj.yearsOfExperience <= 60
        ? Math.round(obj.yearsOfExperience)
        : null;
    const topRoles = Array.isArray(obj.topRoles)
        ? obj.topRoles
            .map((r) => (typeof r === 'string' ? r.trim().slice(0, 120) : ''))
            .filter((r) => r.length >= 2)
            .slice(0, 3)
        : [];
    return { summary, strengths, yearsOfExperience: years, topRoles };
};
const summariseResume = async (args) => {
    const text = (0, promptGuard_service_1.cleanPromptText)(args.resumeText, 'resume_tldr', args.userId).trim();
    if (text.length < 100) {
        return {
            summary: 'Resume too short to summarise.',
            strengths: [],
            yearsOfExperience: null,
            topRoles: [],
            usedAi: false,
            cached: false,
        };
    }
    const ck = cacheKey(text);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            const parsed = JSON.parse(cached);
            return { ...parsed, usedAi: true, cached: true };
        }
    }
    catch (err) {
        logger_1.logger.warn(`resumeTldr cache read: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq')
        ? 'groq'
        : undefined;
    if (!preferred &&
        !(0, providers_1.isProviderEnabled)('gemini')) {
        return {
            summary: 'AI summary unavailable.',
            strengths: [],
            yearsOfExperience: null,
            topRoles: [],
            usedAi: false,
            cached: false,
        };
    }
    try {
        const parsed = await (0, providers_1.generateJson)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: `Resume text:\n"""${text.slice(0, 12000)}"""\n\nReturn the JSON now.`,
            json: true,
            maxTokens: 600,
            temperature: 0.3,
        }, { userId: args.userId, feature: 'resume_tldr' });
        const sane = sanitize(parsed);
        if (!sane) {
            return {
                summary: 'Could not generate summary from this resume.',
                strengths: [],
                yearsOfExperience: null,
                topRoles: [],
                usedAi: false,
                cached: false,
            };
        }
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24 * 30, JSON.stringify(sane));
        }
        catch (err) {
            logger_1.logger.warn(`resumeTldr cache write: ${err.message}`);
        }
        return { ...sane, usedAi: true, cached: false };
    }
    catch (err) {
        logger_1.logger.warn(`resumeTldr failed: ${err.message}`);
        return {
            summary: 'Summary failed — try again.',
            strengths: [],
            yearsOfExperience: null,
            topRoles: [],
            usedAi: false,
            cached: false,
        };
    }
};
exports.summariseResume = summariseResume;
const peekCachedTldr = async (resumeText) => {
    const text = (resumeText || '').trim();
    if (text.length < 100)
        return null;
    try {
        const cached = await redis_1.redis.get(cacheKey(text));
        if (!cached)
            return null;
        const parsed = JSON.parse(cached);
        return { ...parsed, usedAi: true, cached: true };
    }
    catch {
        return null;
    }
};
exports.peekCachedTldr = peekCachedTldr;
