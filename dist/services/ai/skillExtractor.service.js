"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractSkills = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const promptGuard_service_1 = require("./promptGuard.service");
const cacheKey = (text) => {
    const hash = crypto_1.default
        .createHash('sha256')
        .update(text.trim().toLowerCase().slice(0, 8000))
        .digest('hex')
        .slice(0, 24);
    return `ai:skillx:${hash}`;
};
const SYSTEM_PROMPT = `You extract job-relevant SKILLS from a block of text. RULES:

- Output STRICT JSON only: {"skills": ["..."]}.
- Each skill is a short phrase (1-3 words).
- Use canonical casing for tech: "JavaScript", "TypeScript", "React", "Node.js", "PostgreSQL", "Kubernetes", "AWS", "GCP", "Azure".
- Use canonical casing for soft skills: "Communication", "Leadership", "Stakeholder Management".
- Deduplicate: pick ONE form ("react" / "reactjs" / "react.js" → "React").
- Drop generic nouns ("developer", "engineer", "team player").
- Drop product/company names that aren't skills (e.g. "Salesforce" stays — it's a known platform; "ACME Corp" doesn't).
- Skip anything not actually mentioned in the text.
- Return between 0 and 30 items, max.
- Output ONLY the JSON, no markdown fences, no prose.`;
const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object')
        return [];
    const obj = raw;
    if (!Array.isArray(obj.skills))
        return [];
    const seen = new Set();
    const out = [];
    for (const s of obj.skills) {
        if (typeof s !== 'string')
            continue;
        const cleaned = s.trim().slice(0, 60);
        if (cleaned.length < 2)
            continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(cleaned);
        if (out.length >= 30)
            break;
    }
    return out;
};
const extractSkills = async (text, opts = {}) => {
    const trimmed = (0, promptGuard_service_1.cleanPromptText)(text, 'skill_extract', opts.userId).trim();
    if (trimmed.length < 30) {
        return { skills: [], usedAi: false, cached: false };
    }
    const ck = cacheKey(trimmed);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            try {
                const skills = JSON.parse(cached);
                return { skills, usedAi: true, cached: true };
            }
            catch {
            }
        }
    }
    catch (err) {
        logger_1.logger.warn(`skillExtractor cache read: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq')
        ? 'groq'
        : undefined;
    if (!preferred && !(0, providers_1.isProviderEnabled)('gemini') && !(0, providers_1.isProviderEnabled)('claude')) {
        return { skills: [], usedAi: false, cached: false };
    }
    try {
        const parsed = await (0, providers_1.generateJson)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: `Text:\n"""\n${trimmed.slice(0, 8000)}\n"""\n\nReturn the JSON now.`,
            json: true,
            maxTokens: 400,
            temperature: 0.2,
        }, { userId: opts.userId, feature: 'skill_extract' });
        const skills = sanitize(parsed);
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24 * 7, JSON.stringify(skills));
        }
        catch (err) {
            logger_1.logger.warn(`skillExtractor cache write: ${err.message}`);
        }
        return { skills, usedAi: true, cached: false };
    }
    catch (err) {
        logger_1.logger.warn(`skillExtractor failed: ${err.message}`);
        return { skills: [], usedAi: false, cached: false };
    }
};
exports.extractSkills = extractSkills;
