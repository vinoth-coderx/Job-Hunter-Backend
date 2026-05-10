import { redis } from '../../config/redis';
import { logger } from '../../utils/logger';
import { IUser } from '../../models/User';
import { generate } from './providers';

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
  role: 'user' | 'model';
  content: string;
  ts: number;
}

const HISTORY_TTL_SEC = 24 * 60 * 60;
const MAX_TURNS = 20;

const historyKey = (userId: string) => `ai:chat:${userId}`;

const buildSystemPrompt = (user: IUser): string => `You are Job Hunter Assist — a career guidance AI built into the Job Hunter app. You help the candidate below find better jobs, improve their resume, prep for interviews, and reason about offers.

CANDIDATE CONTEXT (always reference this — never give generic advice):
- Name: ${user.profile.fullName || 'Unknown'}
- Headline: ${user.profile.headline || 'N/A'}
- Experience: ${user.profile.experienceYears ?? 0} years
- Skills: ${(user.profile.skills || []).slice(0, 30).join(', ') || 'N/A'}
- Preferred Roles: ${(user.profile.preferredRoles || []).join(', ') || 'N/A'}
- Preferred Locations: ${(user.profile.preferredLocations || []).join(', ') || 'N/A'}
- Preferred Job Types: ${(user.profile.preferredJobTypes || []).join(', ') || 'N/A'}
- Has resume on file: ${user.profile.resumeText ? 'yes' : 'no'}

Rules:
- Reply in the same language the user wrote in (English, Tamil, Tanglish — match their style).
- Keep replies under 150 words unless the user explicitly asks for detail.
- When the user asks for jobs, be honest: you can only suggest types of search queries, not actual listings (the app has a separate matching engine for that).
- Never invent skills the candidate doesn't have.
- If the user asks something outside career/jobs/resume scope, politely redirect.`;

export const getChatHistory = async (userId: string): Promise<ChatTurn[]> => {
  const raw = await redis.get(historyKey(userId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ChatTurn[];
    return Array.isArray(parsed) ? parsed : [];
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
  history: ChatTurn[];
}

export const sendChatMessage = async (
  user: IUser,
  message: string,
): Promise<ChatResponse> => {
  const userId = String(user._id);
  const text = (message || '').trim().slice(0, 2000);
  if (!text) throw new Error('Empty message');

  const history = await getChatHistory(userId);
  const userPrompt = `${renderHistory(history)}User: ${text}\n\nAssistant:`;

  const res = await generate({
    tier: 'smart',
    system: buildSystemPrompt(user),
    user: userPrompt,
    maxTokens: 800,
    temperature: 0.6,
  });

  const reply = res.text.trim();
  const next = trim([
    ...history,
    { role: 'user', content: text, ts: Date.now() },
    { role: 'model', content: reply, ts: Date.now() },
  ]);

  try {
    await redis.setex(historyKey(userId), HISTORY_TTL_SEC, JSON.stringify(next));
  } catch (err) {
    logger.warn(`chat history persist failed: ${(err as Error).message}`);
  }

  return { reply, history: next };
};
