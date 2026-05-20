"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isGeminiStreamingAvailable = void 0;
exports.streamChat = streamChat;
const crypto_1 = __importDefault(require("crypto"));
const genai_1 = require("@google/genai");
const redis_1 = require("../../config/redis");
const logger_1 = require("../../utils/logger");
const config_service_1 = require("../config/config.service");
const constants_1 = require("../../config/constants");
const promptGuard_service_1 = require("./promptGuard.service");
const usageLog_service_1 = require("./usageLog.service");
const HISTORY_TTL_SEC = 24 * 60 * 60;
const MAX_TURNS = 20;
const historyKey = (userId) => `ai:chat:${userId}`;
const buildSystemPrompt = (user) => `You are Job Hunter Assist — a career guidance AI built INTO the Job Hunter mobile app. You help the candidate below find better jobs, improve their resume, prep for interviews, and reason about offers. You are NOT a generic career chatbot — every answer must route the user into Job Hunter's own features.

CANDIDATE CONTEXT (always reference this — never give generic advice):
- Name: ${user.profile.fullName || 'Unknown'}
- Headline: ${user.profile.headline || 'N/A'}
- Experience: ${user.profile.experienceYears ?? 0} years
- Skills: ${(user.profile.skills || []).slice(0, 30).join(', ') || 'N/A'}
- Preferred Roles: ${(user.profile.preferredRoles || []).join(', ') || 'N/A'}
- Has resume on file: ${user.profile.resumeText ? 'yes' : 'no'}

JOB HUNTER FEATURES (the only places you should ever point the user to):
- "Home" tab → "Hand-picked for you" carousel + freshest jobs matched to this candidate.
- "Search" tab → keyword + filter search across the matched job pool (voice search supported).
- "Saved jobs" → user-shortlisted bookmarks.
- "Auto-Apply" → AI applies on the user's behalf overnight ("You sleep. We apply.").
- "Applied" tab → status of every application + interview schedule.
- "Resume & Essentials" (Profile tab) → upload resume, AI auto-fill, edit chips.
- "ATS Score" / "Skill Gap" / "Profile coach" / "Mock interview" → resume + interview tooling.

HARD RULES — never break these:
- NEVER recommend external job portals or third-party sites. NEVER mention LinkedIn, Naukri, Indeed, Monster, Glassdoor, Foundit, Shine, AngelList, Wellfound, Hirect, Apna, Cutshort, or any competitor — by name or by hint. Route the user inside Job Hunter.
- NEVER tell the user to "search elsewhere", "open another app", or "type queries into a job portal".
- NEVER fabricate apply URLs or "redirect" links. Direct the user to a job's detail screen and the Apply button there.
- When the user asks for jobs / links / "where do I find roles" → name the in-app tab + filter or feature (Hand-picked, Auto-Apply, Saved jobs) instead.
- Never invent skills the candidate doesn't have.
- If the user asks something outside career/jobs/resume scope, politely redirect.

Reply rules:
- Match the user's language (English, Tamil, Tanglish).
- Keep replies under 150 words unless the user explicitly asks for detail.
- Be concrete: name the actual feature ("Open Auto-Apply from the Profile tab") instead of vague advice.`;
const renderHistory = (turns) => {
    if (turns.length === 0)
        return '';
    return ('CONVERSATION SO FAR:\n' +
        turns
            .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
            .join('\n\n') +
        '\n\n');
};
const trim = (turns) => turns.length <= MAX_TURNS ? turns : turns.slice(turns.length - MAX_TURNS);
let cachedClient = null;
const getGeminiClient = () => {
    const key = (0, config_service_1.getAppConfig)('GEMINI_API_KEY');
    if (!key)
        return null;
    if (cachedClient && cachedClient.key === key)
        return cachedClient.client;
    cachedClient = { key, client: new genai_1.GoogleGenAI({ apiKey: key }) };
    return cachedClient.client;
};
const isGeminiStreamingAvailable = () => getGeminiClient() !== null;
exports.isGeminiStreamingAvailable = isGeminiStreamingAvailable;
async function* streamChat(user, message, history) {
    const client = getGeminiClient();
    if (!client) {
        throw new Error('Gemini streaming unavailable — GEMINI_API_KEY not set');
    }
    const userId = String(user._id);
    const guarded = (0, promptGuard_service_1.cleanPromptText)(message, 'chat', userId).trim().slice(0, 2000);
    if (!guarded)
        throw new Error('Empty message');
    const userPrompt = `${renderHistory(history)}User: ${guarded}\n\nAssistant:`;
    const startedAt = Date.now();
    let assembled = '';
    let inputTokens;
    let outputTokens;
    try {
        const stream = await client.models.generateContentStream({
            model: constants_1.GEMINI_MODEL_SMART,
            contents: userPrompt,
            config: {
                systemInstruction: buildSystemPrompt(user),
                temperature: 0.6,
                maxOutputTokens: 800,
            },
        });
        for await (const chunk of stream) {
            const text = chunk.text ?? '';
            if (text.length > 0) {
                assembled += text;
                yield { chunk: { delta: text } };
            }
            const usage = chunk.usageMetadata;
            if (usage) {
                inputTokens = usage.promptTokenCount ?? inputTokens;
                outputTokens = usage.candidatesTokenCount ?? outputTokens;
            }
        }
    }
    catch (err) {
        (0, usageLog_service_1.recordAiUsage)({
            userId,
            feature: 'chat:stream',
            provider: 'gemini',
            tier: 'smart',
            latencyMs: Date.now() - startedAt,
            success: false,
            errorCode: err?.name ?? 'error',
        });
        throw err;
    }
    const reply = assembled.trim();
    if (!reply) {
        throw new Error('Empty model reply');
    }
    const now = Date.now();
    const turnId = crypto_1.default.randomUUID();
    const next = trim([
        ...history,
        { id: crypto_1.default.randomUUID(), role: 'user', content: guarded, ts: now },
        { id: turnId, role: 'model', content: reply, ts: now },
    ]);
    try {
        await redis_1.redis.setex(historyKey(userId), HISTORY_TTL_SEC, JSON.stringify(next));
    }
    catch (err) {
        logger_1.logger.warn(`stream history persist failed: ${err.message}`);
    }
    (0, usageLog_service_1.recordAiUsage)({
        userId,
        feature: 'chat:stream',
        provider: 'gemini',
        tier: 'smart',
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startedAt,
        success: true,
    });
    yield {
        final: { reply, turnId, inputTokens, outputTokens },
    };
}
