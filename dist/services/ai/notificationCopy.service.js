"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.polishEmailSubject = exports.rewriteNotificationCopy = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const cacheKey = (args) => {
    const ctx = args.context
        ? Object.entries(args.context)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('|')
        : '';
    const hash = crypto_1.default
        .createHash('sha256')
        .update(`${args.kind ?? 'push'}||${args.type}||${args.title}||${args.body}||${ctx}`)
        .digest('hex')
        .slice(0, 24);
    return `ai:notif:${hash}`;
};
const SYSTEM_PUSH = `You rewrite mobile push notifications so they read better. RULES:

- Output STRICT JSON: {"title": "...", "body": "..."}.
- Title: max 50 chars, action-led when natural, no trailing period.
- Body: max 120 chars, 1-2 short sentences, friendly + specific.
- Preserve EVERY concrete detail in the input (job title, company, score, count, currency). NEVER invent.
- Never add emoji unless the input already had one.
- Never use ALL CAPS, exclamation marks, or marketing fluff ("amazing!", "don't miss!").
- If the input is already great, return it unchanged.
- Output ONLY the JSON, no markdown fences, no prose.`;
const SYSTEM_EMAIL_SUBJECT = `You rewrite transactional email subject lines so they get opened. RULES:

- Output STRICT JSON: {"title": "...", "body": ""}.
- Title (subject line): max 60 chars, specific, no trailing period.
- Preserve EVERY concrete detail (job title, company, count). NEVER invent.
- Never add emoji unless the input already had one.
- Never use ALL CAPS, exclamation marks, or marketing fluff.
- "body" MUST be an empty string — we only rewrite the subject for emails.
- If the input is already great, return it unchanged.
- Output ONLY the JSON, no markdown fences, no prose.`;
const systemFor = (kind) => kind === 'email_subject' ? SYSTEM_EMAIL_SUBJECT : SYSTEM_PUSH;
const sanitize = (raw, fallback, kind) => {
    if (!raw || typeof raw !== 'object')
        return fallback;
    const obj = raw;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const body = typeof obj.body === 'string' ? obj.body.trim() : '';
    if (!title)
        return fallback;
    if (kind === 'email_subject') {
        return { title: title.slice(0, 80), body: '' };
    }
    if (!body)
        return fallback;
    return { title: title.slice(0, 80), body: body.slice(0, 200) };
};
const rewriteNotificationCopy = async (args) => {
    const kind = args.kind ?? 'push';
    const fallback = { title: args.title, body: args.body };
    if (!args.title.trim())
        return fallback;
    if (kind === 'push' && !args.body.trim())
        return fallback;
    const ck = cacheKey(args);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed.title &&
                    (kind === 'email_subject' || parsed.body)) {
                    return parsed;
                }
            }
            catch {
            }
        }
    }
    catch (err) {
        logger_1.logger.warn(`notificationCopy cache read: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq')
        ? 'groq'
        : undefined;
    if (!preferred && !(0, providers_1.isProviderEnabled)('gemini') && !(0, providers_1.isProviderEnabled)('claude')) {
        return fallback;
    }
    const userPrompt = [
        `Type: ${args.type}`,
        kind === 'email_subject' ? `Subject: ${args.title}` : `Title: ${args.title}`,
        args.body.trim() ? `Body: ${args.body}` : null,
        args.context
            ? `Context: ${Object.entries(args.context)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ')}`
            : null,
        'Return the JSON now.',
    ]
        .filter(Boolean)
        .join('\n');
    try {
        const res = await (0, providers_1.generate)({
            provider: preferred,
            tier: 'lite',
            system: systemFor(kind),
            user: userPrompt,
            json: true,
            maxTokens: 200,
            temperature: 0.45,
        }, { feature: 'notification_copy' });
        const cleaned = res.text
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, '')
            .trim();
        let parsed = null;
        try {
            parsed = JSON.parse(cleaned);
        }
        catch {
            return fallback;
        }
        const out = sanitize(parsed, fallback, kind);
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24 * 30, JSON.stringify(out));
        }
        catch (err) {
            logger_1.logger.warn(`notificationCopy cache write: ${err.message}`);
        }
        return out;
    }
    catch (err) {
        logger_1.logger.warn(`notificationCopy failed: ${err.message}`);
        return fallback;
    }
};
exports.rewriteNotificationCopy = rewriteNotificationCopy;
const polishEmailSubject = async (subject, type, context) => {
    const result = await (0, exports.rewriteNotificationCopy)({
        title: subject,
        body: '',
        type,
        context,
        kind: 'email_subject',
    });
    return result.title || subject;
};
exports.polishEmailSubject = polishEmailSubject;
