import crypto from 'crypto';
import { redis } from '../../config/redis';
import { logger } from '../../utils/logger';
import { IUser } from '../../models/User';
import { generateJson } from './providers';
import { cleanPromptText } from './promptGuard.service';

/**
 * Conversational AI assistant for job seekers.
 *
 * Conversation history is stored in Redis (key per user, 24-hour TTL) so
 * follow-up questions retain context without burning MongoDB write traffic.
 * Each call ships the user's profile snapshot as system context so the
 * model speaks in terms of THEIR skills/preferences, not generic advice.
 *
 * One quota slot per user message. Counts both new sessions and follow-ups.
 */

export interface ChatTurn {
  /** Stable id so the client can attach feedback / re-render diffs without
   *  relying on array index (history rolls over at MAX_TURNS). Old rows
   *  read from Redis before this field existed default to ''. */
  id: string;
  role: 'user' | 'model';
  content: string;
  ts: number;
  /** AI-suggested next questions the user might want to ask. Only set
   *  on `role: 'model'` turns; UI surfaces them as tappable chips under
   *  the latest reply. Best-effort: may be empty when the model didn't
   *  return a parseable JSON. */
  followUps?: string[];
}

const HISTORY_TTL_SEC = 24 * 60 * 60;
const MAX_TURNS = 20;

const historyKey = (userId: string) => `ai:chat:${userId}`;

const buildSystemPrompt = (user: IUser): string => `You are Job Hunter Assist — a career guidance AI built INTO the Job Hunter mobile app. You help the candidate below find better jobs, improve their resume, prep for interviews, and reason about offers. You are NOT a generic career chatbot — every answer must route the user into Job Hunter's own features.

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

export const getChatHistory = async (userId: string): Promise<ChatTurn[]> => {
  const raw = await redis.get(historyKey(userId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ChatTurn[];
    if (!Array.isArray(parsed)) return [];
    // Backfill ids for legacy rows so the client can always attach
    // feedback. Empty-string is safe — feedback endpoint validates length.
    return parsed.map((t) => ({ ...t, id: t.id || '' }));
  } catch {
    return [];
  }
};

export const clearChatHistory = async (userId: string): Promise<void> => {
  await redis.del(historyKey(userId));
};

const trim = (turns: ChatTurn[]): ChatTurn[] =>
  turns.length <= MAX_TURNS ? turns : turns.slice(turns.length - MAX_TURNS);

const renderHistory = (turns: ChatTurn[]): string => {
  if (turns.length === 0) return '';
  return (
    'CONVERSATION SO FAR:\n' +
    turns
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n\n') +
    '\n\n'
  );
};

export interface ChatResponse {
  reply: string;
  followUps: string[];
  history: ChatTurn[];
}

interface RawChatJson {
  reply?: unknown;
  followUps?: unknown;
}

const sanitizeFollowUps = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, 140);
    if (trimmed.length < 4) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 3) break;
  }
  return out;
};

export const sendChatMessage = async (
  user: IUser,
  message: string,
): Promise<ChatResponse> => {
  const userId = String(user._id);
  // Strip prompt-injection markers BEFORE we slice — the redaction
  // tokens are short, and we want the user-visible "saved" message to
  // match what we actually sent to the model.
  const guarded = cleanPromptText(message, 'chat', userId);
  const text = guarded.trim().slice(0, 2000);
  if (!text) throw new Error('Empty message');

  const history = await getChatHistory(userId);
  const userPrompt = `${renderHistory(history)}User: ${text}\n\nAssistant:`;

  const parsed = await generateJson<RawChatJson>(
    {
      tier: 'smart',
      system: buildSystemPrompt(user),
      user: userPrompt,
      json: true,
      maxTokens: 900,
      temperature: 0.6,
    },
    { userId, feature: 'chat' },
  );

  const reply =
    typeof parsed?.reply === 'string'
      ? parsed.reply.trim()
      : '';
  if (!reply) {
    // Model failed to follow JSON contract — keep the user moving with
    // a one-line apology + empty follow-ups so the UI doesn't render a
    // blank model bubble.
    return {
      reply:
        "Sorry, I couldn't generate a reply. Try rephrasing or ask something else.",
      followUps: [],
      history,
    };
  }
  const followUps = sanitizeFollowUps(parsed?.followUps);

  const now = Date.now();
  const next = trim([
    ...history,
    { id: crypto.randomUUID(), role: 'user', content: text, ts: now },
    {
      id: crypto.randomUUID(),
      role: 'model',
      content: reply,
      ts: now,
      followUps,
    },
  ]);

  try {
    await redis.setex(historyKey(userId), HISTORY_TTL_SEC, JSON.stringify(next));
  } catch (err) {
    logger.warn(`chat history persist failed: ${(err as Error).message}`);
  }

  return { reply, followUps, history: next };
};
