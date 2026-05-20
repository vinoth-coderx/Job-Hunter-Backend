"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.polishJd = exports.peekCachedPolishedJd = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const promptGuard_service_1 = require("./promptGuard.service");
const cacheKey = (title, description) => {
    const hash = crypto_1.default
        .createHash('sha256')
        .update(`${title.toLowerCase().trim()}||${description}`)
        .digest('hex')
        .slice(0, 24);
    return `ai:jdpolish:${hash}`;
};
const SYSTEM_PROMPT = `You polish a hiring manager's job description draft. Your job is to make it CLEARER, MORE INCLUSIVE, and BETTER STRUCTURED — never to change the substance or invent requirements.

RULES:
- Output STRICT JSON: {"polished": "...", "changes": ["...", "..."]}.
- "polished": the rewritten description as plain text. Keep paragraph breaks. Length within ±25% of the input.
- "changes": 2-5 short bullets explaining what you fixed (e.g. "split monolithic paragraph into responsibilities + qualifications").
- DO add: clear "Responsibilities", "Requirements", "Nice to have" sections when the input is one big blob.
- DO replace gendered words ("salesman" → "salesperson", "manpower" → "workforce").
- DO replace ageist filters ("digital native", "young & energetic") with skill-based equivalents.
- DO break long run-on sentences into shorter ones.
- DON'T add new skills, technologies, salary, or location not in the original.
- DON'T change the seniority level or role title.
- DON'T add marketing fluff ("rockstar", "exciting opportunity", "fast-paced").
- If the original is already great, return it unchanged with an empty changes array.
- Output ONLY the JSON, no markdown fences, no prose.`;
const sanitize = (raw, fallback) => {
    if (!raw || typeof raw !== 'object') {
        return { polished: fallback, changes: [], usedAi: false, cached: false };
    }
    const obj = raw;
    const polished = typeof obj.polished === 'string' && obj.polished.trim().length > 50
        ? obj.polished.trim().slice(0, 20000)
        : '';
    if (!polished) {
        return { polished: fallback, changes: [], usedAi: false, cached: false };
    }
    const changes = Array.isArray(obj.changes)
        ? obj.changes
            .filter((c) => typeof c === 'string')
            .map((c) => c.trim().slice(0, 200))
            .filter((c) => c.length > 0)
            .slice(0, 5)
        : [];
    return { polished, changes, usedAi: true, cached: false };
};
const peekCachedPolishedJd = async (title, description) => {
    if (!description || description.length < 50)
        return null;
    try {
        const raw = await redis_1.redis.get(cacheKey(title, description));
        if (!raw)
            return null;
        const parsed = JSON.parse(raw);
        return { ...parsed, usedAi: true, cached: true };
    }
    catch {
        return null;
    }
};
exports.peekCachedPolishedJd = peekCachedPolishedJd;
const polishJd = async (args) => {
    const description = (0, promptGuard_service_1.cleanPromptText)(args.description, 'jd_polish', args.userId).trim();
    if (description.length < 50) {
        return { polished: description, changes: [], usedAi: false, cached: false };
    }
    const ck = cacheKey(args.title, description);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            const parsed = JSON.parse(cached);
            return { ...parsed, usedAi: true, cached: true };
        }
    }
    catch (err) {
        logger_1.logger.warn(`jdPolish cache read: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq')
        ? 'groq'
        : undefined;
    if (!preferred &&
        !(0, providers_1.isProviderEnabled)('gemini') &&
        !(0, providers_1.isProviderEnabled)('claude')) {
        return { polished: description, changes: [], usedAi: false, cached: false };
    }
    try {
        const parsed = await (0, providers_1.generateJson)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: `Job title: ${args.title}\n\nDescription:\n"""\n${description.slice(0, 12000)}\n"""\n\nReturn the JSON now.`,
            json: true,
            maxTokens: 2000,
            temperature: 0.4,
        }, { userId: args.userId, feature: 'jd_polish' });
        const result = sanitize(parsed, description);
        if (!result.usedAi)
            return result;
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24, JSON.stringify({ polished: result.polished, changes: result.changes }));
        }
        catch (err) {
            logger_1.logger.warn(`jdPolish cache write: ${err.message}`);
        }
        return result;
    }
    catch (err) {
        logger_1.logger.warn(`jdPolish failed: ${err.message}`);
        return { polished: description, changes: [], usedAi: false, cached: false };
    }
};
exports.polishJd = polishJd;
