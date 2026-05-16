import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { redis } from '../../config/redis';
import { logger } from '../../utils/logger';
import { IUser } from '../../models/User';
import { getAppConfig } from '../config/config.service';
import {
  GEMINI_MODEL_LITE,
  GEMINI_MODEL_SMART,
} from '../../config/constants';
import { cleanPromptText } from './promptGuard.service';
import type { ChatTurn } from './assistant.service';
import { recordAiUsage } from './usageLog.service';

/**
 * Server-side streaming for the chat assistant. Bypasses the regular
 * `generate` wrapper because the wrapper is request/response — for SSE
 * we need to yield chunks as the model produces them.
 *
 * Persists the final reply to Redis history just like the non-streaming
 * path so quota accounting + history + follow-ups stay consistent.
 *
 * Provider: Gemini only for now. Adding Claude streaming would mean a
 * second SDK branch — out of scope for this slice. Falls back to the
 * non-streaming path at the controller layer when Gemini isn't enabled.
 */

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

const trim = (turns: ChatTurn[]): ChatTurn[] =>
  turns.length <= MAX_TURNS ? turns : turns.slice(turns.length - MAX_TURNS);

let cachedClient: { key: string; client: GoogleGenAI } | null = null;
const getGeminiClient = (): GoogleGenAI | null => {
  const key = getAppConfig('GEMINI_API_KEY');
  if (!key) return null;
  if (cachedClient && cachedClient.key === key) return cachedClient.client;
  cachedClient = { key, client: new GoogleGenAI({ apiKey: key }) };
  return cachedClient.client;
};

export interface StreamChunk {
  /** Incremental text delta. */
  delta: string;
}

export interface StreamFinal {
  /** Full assembled reply, persisted to history. */
  reply: string;
  /** Stable id for the model turn — used for thumbs feedback. */
  turnId: string;
  inputTokens?: number;
  outputTokens?: number;
}

export const isGeminiStreamingAvailable = (): boolean =>
  getGeminiClient() !== null;

/**
 * Async generator: yields each text delta as it arrives, then a final
 * sentinel with the assembled reply + token usage. Caller is
 * responsible for SSE framing + flushing.
 */
export async function* streamChat(
  user: IUser,
  message: string,
  history: ChatTurn[],
): AsyncGenerator<{ chunk?: StreamChunk; final?: StreamFinal }, void, void> {
  const client = getGeminiClient();
  if (!client) {
    throw new Error('Gemini streaming unavailable — GEMINI_API_KEY not set');
  }

  const userId = String(user._id);
  const guarded = cleanPromptText(message, 'chat', userId).trim().slice(0, 2000);
  if (!guarded) throw new Error('Empty message');

  const userPrompt = `${renderHistory(history)}User: ${guarded}\n\nAssistant:`;
  const startedAt = Date.now();

  let assembled = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    const stream = await client.models.generateContentStream({
      model: GEMINI_MODEL_SMART,
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
      // Token usage typically lands on the FINAL chunk only.
      const usage = chunk.usageMetadata;
      if (usage) {
        inputTokens = usage.promptTokenCount ?? inputTokens;
        outputTokens = usage.candidatesTokenCount ?? outputTokens;
      }
    }
  } catch (err) {
    // Telemetry: log the failure but rethrow so the controller can
    // close the SSE stream with a clear error event.
    recordAiUsage({
      userId,
      feature: 'chat:stream',
      provider: 'gemini',
      tier: 'smart',
      latencyMs: Date.now() - startedAt,
      success: false,
      errorCode: (err as Error)?.name ?? 'error',
    });
    throw err;
  }

  const reply = assembled.trim();
  if (!reply) {
    throw new Error('Empty model reply');
  }

  // Persist history + log usage. Mirror sendChatMessage so the chat
  // screen sees the same history shape regardless of which path served
  // the call.
  const now = Date.now();
  const turnId = crypto.randomUUID();
  const next = trim([
    ...history,
    { id: crypto.randomUUID(), role: 'user', content: guarded, ts: now },
    { id: turnId, role: 'model', content: reply, ts: now },
  ]);
  try {
    await redis.setex(historyKey(userId), HISTORY_TTL_SEC, JSON.stringify(next));
  } catch (err) {
    logger.warn(`stream history persist failed: ${(err as Error).message}`);
  }

  recordAiUsage({
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
