"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestSmartReplies = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const promptGuard_service_1 = require("./promptGuard.service");
const cacheKey = (turns) => {
    const slim = turns
        .slice(-6)
        .map((t) => `${t.role}:${t.text.toLowerCase().trim().slice(0, 240)}`)
        .join('||');
    const hash = crypto_1.default.createHash('sha256').update(slim).digest('hex').slice(0, 24);
    return `ai:smartreply:${hash}`;
};
const SYSTEM_PROMPT = `You suggest 3 short reply options a RECRUITER can send to a CANDIDATE in a hiring chat. RULES:

- Output STRICT JSON: {"suggestions": ["...", "...", "..."]}.
- 3 suggestions max. Each 4-15 words.
- Reply from the RECRUITER'S point of view, addressing the candidate's last message specifically.
- One should be a clear positive ("Great, let's…"), one neutral ("Tell me more about…"), one polite decline / hold ("Let me check and get back to you").
- No marketing fluff. No emoji unless the conversation already has them.
- Never ask for money, OTP, bank details, or redirect off-platform.
- If the candidate asked a specific question, answer it (or acknowledge + commit to follow up).
- Output ONLY the JSON, no markdown fences, no prose.`;
const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object')
        return [];
    const obj = raw;
    if (!Array.isArray(obj.suggestions))
        return [];
    const seen = new Set();
    const out = [];
    for (const s of obj.suggestions) {
        if (typeof s !== 'string')
            continue;
        const trimmed = s.trim().slice(0, 200);
        if (trimmed.length < 3)
            continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(trimmed);
        if (out.length >= 3)
            break;
    }
    return out;
};
const heuristic = () => [
    "Thanks for reaching out — could you tell me more about what you're looking for?",
    "Great, let me check on this and get back to you shortly.",
    "Appreciate the interest, but this role isn't quite the right fit right now.",
];
const suggestSmartReplies = async (args) => {
    const turns = args.turns
        .filter((t) => t && (t.role === 'hirer' || t.role === 'candidate'))
        .slice(-8)
        .map((t) => ({
        role: t.role,
        text: (0, promptGuard_service_1.cleanPromptText)(t.text, 'chat_smart_reply', args.userId)
            .trim()
            .slice(0, 1000),
    }))
        .filter((t) => t.text.length > 0);
    if (turns.length === 0 || turns[turns.length - 1].role !== 'candidate') {
        return { suggestions: heuristic(), usedAi: false, cached: false };
    }
    const ck = cacheKey(turns);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            const parsed = JSON.parse(cached);
            return { suggestions: parsed, usedAi: true, cached: true };
        }
    }
    catch (err) {
        logger_1.logger.warn(`smartReply cache read: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq')
        ? 'groq'
        : undefined;
    if (!preferred &&
        !(0, providers_1.isProviderEnabled)('gemini') &&
        !(0, providers_1.isProviderEnabled)('claude')) {
        return { suggestions: heuristic(), usedAi: false, cached: false };
    }
    const transcript = turns
        .map((t) => `${t.role === 'hirer' ? 'Recruiter' : 'Candidate'}: ${t.text}`)
        .join('\n');
    try {
        const parsed = await (0, providers_1.generateJson)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: `CONVERSATION:\n${transcript}\n\nReturn the JSON now.`,
            json: true,
            maxTokens: 300,
            temperature: 0.55,
        }, { userId: args.userId, feature: 'chat_smart_reply' });
        const suggestions = sanitize(parsed);
        if (suggestions.length === 0) {
            return { suggestions: heuristic(), usedAi: false, cached: false };
        }
        try {
            await redis_1.redis.setex(ck, 60 * 60, JSON.stringify(suggestions));
        }
        catch (err) {
            logger_1.logger.warn(`smartReply cache write: ${err.message}`);
        }
        return { suggestions, usedAi: true, cached: false };
    }
    catch (err) {
        logger_1.logger.warn(`smartReply failed: ${err.message}`);
        return { suggestions: heuristic(), usedAi: false, cached: false };
    }
};
exports.suggestSmartReplies = suggestSmartReplies;
