"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestAlertNames = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const cacheKey = (input) => {
    const filters = [...(input.filters ?? [])]
        .map((f) => f.toLowerCase().trim())
        .filter((f) => f.length > 0)
        .sort()
        .join(',');
    const hash = crypto_1.default
        .createHash('sha256')
        .update(`${input.query.toLowerCase().trim()}||${filters}||${(input.location ?? '').toLowerCase().trim()}`)
        .digest('hex')
        .slice(0, 24);
    return `ai:alertname:${hash}`;
};
const SYSTEM_PROMPT = `You name a job-search alert so the user remembers what it tracks. Output STRICT JSON.

RULES:
- Output {"names": ["...", "...", "..."]}.
- 2-3 names. Each 3-6 words. Title Case.
- Lead with the role / skill, then location only if specified.
- No emoji. No marketing fluff. No exclamation marks.
- Don't repeat the literal query verbatim — that's already what the user typed.
- Don't invent details that aren't in the input.
- Output ONLY the JSON, no markdown fences, no prose.`;
const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object')
        return [];
    const obj = raw;
    if (!Array.isArray(obj.names))
        return [];
    const seen = new Set();
    const out = [];
    for (const n of obj.names) {
        if (typeof n !== 'string')
            continue;
        const cleaned = n.trim().slice(0, 60);
        if (cleaned.length < 4)
            continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(cleaned);
        if (out.length >= 3)
            break;
    }
    return out;
};
const heuristic = (input) => {
    const titleCase = (s) => s
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    const role = titleCase(input.query.trim());
    const loc = (input.location ?? '').trim();
    if (role && loc)
        return [`${role} in ${titleCase(loc)}`];
    if (role)
        return [role];
    if (loc)
        return [`${titleCase(loc)} jobs`];
    return ['New alert'];
};
const suggestAlertNames = async (input, opts = {}) => {
    const query = (input.query || '').trim();
    if (query.length === 0 && !(input.location ?? '').trim()) {
        return [];
    }
    const ck = cacheKey(input);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed) && parsed.length > 0)
                return parsed;
        }
    }
    catch (err) {
        logger_1.logger.warn(`alertNamer cache read: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq')
        ? 'groq'
        : undefined;
    if (!preferred &&
        !(0, providers_1.isProviderEnabled)('gemini')) {
        return heuristic(input);
    }
    const userPrompt = [
        `Query: "${query}"`,
        input.filters && input.filters.length > 0
            ? `Filters: ${input.filters.slice(0, 12).join(', ')}`
            : null,
        input.location ? `Location: ${input.location}` : null,
        'Return the JSON now.',
    ]
        .filter(Boolean)
        .join('\n');
    try {
        const parsed = await (0, providers_1.generateJson)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: userPrompt,
            json: true,
            maxTokens: 150,
            temperature: 0.5,
        }, { userId: opts.userId, feature: 'alert_name' });
        const names = sanitize(parsed);
        if (names.length === 0)
            return heuristic(input);
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24 * 7, JSON.stringify(names));
        }
        catch (err) {
            logger_1.logger.warn(`alertNamer cache write: ${err.message}`);
        }
        return names;
    }
    catch (err) {
        logger_1.logger.warn(`alertNamer failed: ${err.message}`);
        return heuristic(input);
    }
};
exports.suggestAlertNames = suggestAlertNames;
