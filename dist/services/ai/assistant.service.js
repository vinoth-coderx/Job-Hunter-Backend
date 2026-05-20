"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendChatMessage = exports.clearChatHistory = exports.getChatHistory = void 0;
const crypto_1 = __importDefault(require("crypto"));
const redis_1 = require("../../config/redis");
const logger_1 = require("../../utils/logger");
const providers_1 = require("./providers");
const promptGuard_service_1 = require("./promptGuard.service");
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
- Preferred Locations: ${(user.profile.preferredLocations || []).join(', ') || 'N/A'}
- Preferred Job Types: ${(user.profile.preferredJobTypes || []).join(', ') || 'N/A'}
- Has resume on file: ${user.profile.resumeText ? 'yes' : 'no'}

JOB HUNTER FEATURES (the only places you should ever point the user to):
- "Home" tab → personalised "Hand-picked for you" carousel + freshest jobs (matched to this candidate's profile).
- "Search" tab → keyword + filter search across the same matched job pool; voice search supported.
- "Saved jobs" → bookmarks the user already shortlisted.
- "Auto-Apply" → AI applies on the user's behalf overnight ("You sleep. We apply.").
- "Applied" tab → status of every application + interview schedule.
- "Resume & Essentials" (Profile tab) → upload resume, AI auto-fill, edit chips.
- "ATS Score" → resume-vs-job keyword score.
- "Skill Gap" → gap analysis for a target role.
- "Profile coach" → AI suggestions to strengthen the profile.
- "Mock interview" → AI-driven practice rounds.

HARD RULES — never break these:
- NEVER recommend external job portals or third-party sites. NEVER mention LinkedIn, Naukri, Indeed, Monster, Glassdoor, Foundit, Shine, AngelList, Wellfound, Hirect, Apna, Cutshort, or any competitor — by name or by hint. The candidate already chose Job Hunter; route them inside.
- NEVER tell the user to "search elsewhere", "open another app", or "type into a job portal".
- NEVER fabricate apply URLs or "redirect" links. The Apply button on each job's detail screen is the only legitimate apply path — point there.
- When the user asks for jobs / links / "where do I find roles" → answer with concrete in-app steps: which tab to open, which filter to apply, which feature (Auto-Apply, Hand-picked, Saved jobs) to lean on.
- Never invent skills the candidate doesn't have.
- If the user asks something outside career/jobs/resume scope, politely redirect inside the reply.

Reply rules:
- Match the user's language (English, Tamil, Tanglish).
- Keep "reply" under 150 words unless the user explicitly asks for detail.
- Be concrete: name the actual feature ("Open Auto-Apply from the Profile tab") instead of vague advice ("look online").

Output STRICT JSON only — no prose, no markdown fences:
{
  "reply": "your full answer here",
  "followUps": ["short follow-up question the user might tap", "another", "another"]
}

followUps rules:
- 0-3 items. Each 4-12 words, framed as the USER'S question (not "I can help you with X").
- Suggest natural next steps tied to the candidate's actual context AND in-app features.
- Skip when the conversation is clearly closed (user said "thanks", "bye", "ok").`;
const getChatHistory = async (userId) => {
    const raw = await redis_1.redis.get(historyKey(userId));
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.map((t) => ({ ...t, id: t.id || '' }));
    }
    catch {
        return [];
    }
};
exports.getChatHistory = getChatHistory;
const clearChatHistory = async (userId) => {
    await redis_1.redis.del(historyKey(userId));
};
exports.clearChatHistory = clearChatHistory;
const trim = (turns) => turns.length <= MAX_TURNS ? turns : turns.slice(turns.length - MAX_TURNS);
const renderHistory = (turns) => {
    if (turns.length === 0)
        return '';
    return ('CONVERSATION SO FAR:\n' +
        turns
            .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
            .join('\n\n') +
        '\n\n');
};
const sanitizeFollowUps = (raw) => {
    if (!Array.isArray(raw))
        return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'string')
            continue;
        const trimmed = item.trim().slice(0, 140);
        if (trimmed.length < 4)
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
const sendChatMessage = async (user, message) => {
    const userId = String(user._id);
    const guarded = (0, promptGuard_service_1.cleanPromptText)(message, 'chat', userId);
    const text = guarded.trim().slice(0, 2000);
    if (!text)
        throw new Error('Empty message');
    const history = await (0, exports.getChatHistory)(userId);
    const userPrompt = `${renderHistory(history)}User: ${text}\n\nAssistant:`;
    const parsed = await (0, providers_1.generateJson)({
        tier: 'smart',
        system: buildSystemPrompt(user),
        user: userPrompt,
        json: true,
        maxTokens: 900,
        temperature: 0.6,
    }, { userId, feature: 'chat' });
    const reply = typeof parsed?.reply === 'string'
        ? parsed.reply.trim()
        : '';
    if (!reply) {
        return {
            reply: "Sorry, I couldn't generate a reply. Try rephrasing or ask something else.",
            followUps: [],
            history,
        };
    }
    const followUps = sanitizeFollowUps(parsed?.followUps);
    const now = Date.now();
    const next = trim([
        ...history,
        { id: crypto_1.default.randomUUID(), role: 'user', content: text, ts: now },
        {
            id: crypto_1.default.randomUUID(),
            role: 'model',
            content: reply,
            ts: now,
            followUps,
        },
    ]);
    try {
        await redis_1.redis.setex(historyKey(userId), HISTORY_TTL_SEC, JSON.stringify(next));
    }
    catch (err) {
        logger_1.logger.warn(`chat history persist failed: ${err.message}`);
    }
    return { reply, followUps, history: next };
};
exports.sendChatMessage = sendChatMessage;
