"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandQuery = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const cacheKey = (query) => {
    const hash = crypto_1.default
        .createHash('sha256')
        .update(query.trim().toLowerCase())
        .digest('hex')
        .slice(0, 24);
    return `ai:qx:${hash}`;
};
const SYSTEM_PROMPT = `You expand a job search query into 3-8 SEARCH SYNONYMS that should also match relevant listings.

RULES:
- Output ONLY the JSON object. No markdown fences, no prose.
- Each synonym is a short phrase (1-4 words), lowercase.
- Include common abbreviations (e.g. "ml engineer" → "machine learning engineer", "mle").
- Include adjacent role titles when they share most of the work (e.g. "frontend developer" → "ui developer", "react developer").
- Skip the original query verbatim — only return ALTERNATIVE phrasings.
- Skip generic words ("developer", "engineer" alone) — they recall too much noise.
- For tech stacks include the canonical names ("react" → "reactjs", "react.js").
- Skip anything you're not confident about.

Schema:
{ "synonyms": ["...", "...", "..."] }`;
const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object')
        return [];
    const obj = raw;
    if (!Array.isArray(obj.synonyms))
        return [];
    const seen = new Set();
    const out = [];
    for (const s of obj.synonyms) {
        if (typeof s !== 'string')
            continue;
        const cleaned = s.trim().toLowerCase().slice(0, 60);
        if (cleaned.length < 2 || cleaned.length > 60)
            continue;
        if (seen.has(cleaned))
            continue;
        seen.add(cleaned);
        out.push(cleaned);
        if (out.length >= 8)
            break;
    }
    return out;
};
const expandQuery = async (query) => {
    const trimmed = (query || '').trim();
    if (trimmed.length < 2)
        return [];
    const ck = cacheKey(trimmed);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            try {
                return JSON.parse(cached);
            }
            catch {
            }
        }
    }
    catch (err) {
        logger_1.logger.warn(`queryExpander cache read failed: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq') ? 'groq' : undefined;
    try {
        const parsed = await (0, providers_1.generateJson)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: `Query: "${trimmed.slice(0, 200)}"\n\nReturn the JSON now.`,
            json: true,
            maxTokens: 200,
            temperature: 0.4,
        }, { feature: 'query_expand' });
        const synonyms = sanitize(parsed).filter((s) => s !== trimmed.toLowerCase());
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24 * 7, JSON.stringify(synonyms));
        }
        catch (err) {
            logger_1.logger.warn(`queryExpander cache write failed: ${err.message}`);
        }
        return synonyms;
    }
    catch (err) {
        logger_1.logger.warn(`queryExpander failed: ${err.message}`);
        return [];
    }
};
exports.expandQuery = expandQuery;
