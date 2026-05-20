"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rewriteResumeText = exports.peekCachedRewrite = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const promptGuard_service_1 = require("./promptGuard.service");
const cacheKey = (kind, text, role, tone) => {
    const hash = crypto_1.default
        .createHash('sha256')
        .update(`${kind}|${text}|${role ?? ''}|${tone ?? ''}`)
        .digest('hex')
        .slice(0, 24);
    return `ai:rewrite:${hash}`;
};
const SYSTEMS = {
    bullet: `You rewrite resume bullets so they pass ATS scanning and impress recruiters. RULES:
- Start with a strong past-tense action verb (Built, Led, Reduced, Shipped, Drove, etc.).
- Quantify with concrete numbers when the input contains them; never invent numbers.
- One sentence, 12-22 words, no period at the end.
- Remove filler ("responsible for", "tasked with", "duties included").
- Preserve the candidate's domain (don't change their tech stack or role).
Output STRICT JSON: {"text":"primary rewrite","alternates":["one alternative phrasing","another alternative phrasing"]}.
- Output ONLY the JSON, no markdown, no prose.`,
    summary: `You rewrite the "Professional Summary" / "About me" section of a resume. RULES:
- 2-4 sentences, 40-80 words total.
- Lead with the candidate's role + years of experience.
- Mention 2-3 strongest skills/specialties from their profile.
- End with the kind of impact or role they're seeking (only if signalled in the input).
- Plain prose, no bullet points, no first-person pronouns.
Output STRICT JSON: {"text":"primary rewrite","alternates":["one shorter version","one slightly different angle"]}.
- Output ONLY the JSON, no markdown, no prose.`,
    achievement: `You rewrite raw "what I did at work" sentences into quantified achievement bullets. RULES:
- Start with a past-tense verb.
- Show impact: who/what was helped, by how much (%/$/users/throughput).
- If the input has numbers, use them. If it doesn't, frame the impact qualitatively (don't fabricate numbers).
- Single sentence, 14-24 words, no trailing period.
Output STRICT JSON: {"text":"primary rewrite","alternates":["alternative phrasing","second alternative"]}.
- Output ONLY the JSON, no markdown, no prose.`,
};
const buildUserPrompt = (kind, text, role, tone) => {
    const lines = [`Original ${kind}:\n"""${text.trim().slice(0, 1500)}"""`];
    if (role)
        lines.push(`Target role / domain: ${role.slice(0, 80)}`);
    if (tone)
        lines.push(`Preferred tone: ${tone}`);
    lines.push('Return the JSON now.');
    return lines.join('\n\n');
};
const parseRewrite = (raw) => {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    if (!cleaned)
        return null;
    try {
        const json = JSON.parse(cleaned);
        const text = typeof json.text === 'string' ? json.text.trim() : '';
        if (!text)
            return null;
        const alternates = Array.isArray(json.alternates)
            ? json.alternates
                .map((a) => (typeof a === 'string' ? a.trim() : ''))
                .filter((a) => a.length > 0 && a !== text)
                .slice(0, 3)
            : [];
        return { text: text.slice(0, 1000), alternates };
    }
    catch (err) {
        logger_1.logger.warn(`resumeRewriter parse failed: ${err.message}`);
        return null;
    }
};
const peekCachedRewrite = async (opts) => {
    const text = (opts.text || '').trim();
    if (text.length < 5)
        return null;
    try {
        const raw = await redis_1.redis.get(cacheKey(opts.kind, text, opts.role, opts.tone));
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
exports.peekCachedRewrite = peekCachedRewrite;
const rewriteResumeText = async (opts) => {
    const text = (0, promptGuard_service_1.cleanPromptText)(opts.text, `resume_rewrite:${opts.kind}`, opts.userId).trim();
    if (text.length < 5) {
        return { text, alternates: [], usedAi: false, cached: false };
    }
    const ck = cacheKey(opts.kind, text, opts.role, opts.tone);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            const parsed = JSON.parse(cached);
            return { ...parsed, usedAi: true, cached: true };
        }
    }
    catch (err) {
        logger_1.logger.warn(`resumeRewriter cache read failed: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq') ? 'groq' : undefined;
    try {
        const res = await (0, providers_1.generate)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEMS[opts.kind],
            user: buildUserPrompt(opts.kind, text, opts.role, opts.tone),
            json: true,
            maxTokens: 600,
            temperature: 0.55,
        }, { userId: opts.userId, feature: `resume_rewrite:${opts.kind}` });
        const parsed = parseRewrite(res.text);
        if (!parsed) {
            return { text, alternates: [], usedAi: false, cached: false };
        }
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24, JSON.stringify(parsed));
        }
        catch (err) {
            logger_1.logger.warn(`resumeRewriter cache write failed: ${err.message}`);
        }
        return { ...parsed, usedAi: true, cached: false };
    }
    catch (err) {
        logger_1.logger.warn(`resumeRewriter failed: ${err.message}`);
        return { text, alternates: [], usedAi: false, cached: false };
    }
};
exports.rewriteResumeText = rewriteResumeText;
