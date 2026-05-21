import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generateJson, isProviderEnabled } from './providers';
import { cleanPromptText } from './promptGuard.service';

/**
 * Smart-reply suggestions for the hirer's chat composer. Given the
 * last few turns of a recruiter ↔ candidate conversation, returns 3
 * short reply variants the recruiter can tap to send. Inspired by
 * Gmail's smart-reply but role-aware: the model knows the recruiter
 * is the one who needs a response.
 *
 * Routed through Groq because the call is short and per-message.
 * Cached 1h server-side by hash(last 6 turns) so quick scrolls
 * through a long thread re-use the same suggestions instead of
 * burning a fresh quota slot per render.
 *
 * Heuristic fallback returns three generic replies so the UI works
 * even when the LLM is down — slightly worse UX, never crashes.
 */

export interface ChatTurnInput {
  /** 'hirer' or 'candidate' — who said it. */
  role: 'hirer' | 'candidate';
  text: string;
}

export interface SmartReplyResult {
  suggestions: string[];
  usedAi: boolean;
  cached: boolean;
}

const cacheKey = (turns: ChatTurnInput[]): string => {
  const slim = turns
    .slice(-6)
    .map(
      (t) =>
        `${t.role}:${t.text.toLowerCase().trim().slice(0, 240)}`,
    )
    .join('||');
  const hash = crypto.createHash('sha256').update(slim).digest('hex').slice(0, 24);
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

const sanitize = (raw: unknown): string[] => {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { suggestions?: unknown };
  if (!Array.isArray(obj.suggestions)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of obj.suggestions) {
    if (typeof s !== 'string') continue;
    const trimmed = s.trim().slice(0, 200);
    if (trimmed.length < 3) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 3) break;
  }
  return out;
};

const heuristic = (): string[] => [
  "Thanks for reaching out — could you tell me more about what you're looking for?",
  "Great, let me check on this and get back to you shortly.",
  "Appreciate the interest, but this role isn't quite the right fit right now.",
];

export interface SmartReplyArgs {
  /** Last N turns of the conversation, oldest-first. */
  turns: ChatTurnInput[];
  /** Hirer user id for usage logging. */
  userId?: string;
}

export const suggestSmartReplies = async (
  args: SmartReplyArgs,
): Promise<SmartReplyResult> => {
  // Sanitise every turn before hashing so a guarded + raw copy can't
  // shard the cache and the model never sees the override tokens.
  const turns = args.turns
    .filter((t) => t && (t.role === 'hirer' || t.role === 'candidate'))
    .slice(-8)
    .map((t) => ({
      role: t.role,
      text: cleanPromptText(t.text, 'chat_smart_reply', args.userId)
        .trim()
        .slice(0, 1000),
    }))
    .filter((t) => t.text.length > 0);

  if (turns.length === 0 || turns[turns.length - 1].role !== 'candidate') {
    // No candidate message to reply to — return generic openers.
    return { suggestions: heuristic(), usedAi: false, cached: false };
  }

  const ck = cacheKey(turns);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      const parsed = JSON.parse(cached) as string[];
      return { suggestions: parsed, usedAi: true, cached: true };
    }
  } catch (err) {
    logger.warn(`smartReply cache read: ${(err as Error).message}`);
  }

  const preferred: 'groq' | undefined = isProviderEnabled('groq')
    ? 'groq'
    : undefined;
  if (
    !preferred &&
    !isProviderEnabled('gemini')
  ) {
    return { suggestions: heuristic(), usedAi: false, cached: false };
  }

  const transcript = turns
    .map(
      (t) =>
        `${t.role === 'hirer' ? 'Recruiter' : 'Candidate'}: ${t.text}`,
    )
    .join('\n');

  try {
    const parsed = await generateJson<unknown>(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEM_PROMPT,
        user: `CONVERSATION:\n${transcript}\n\nReturn the JSON now.`,
        json: true,
        maxTokens: 300,
        temperature: 0.55,
      },
      { userId: args.userId, feature: 'chat_smart_reply' },
    );

    const suggestions = sanitize(parsed);
    if (suggestions.length === 0) {
      return { suggestions: heuristic(), usedAi: false, cached: false };
    }

    try {
      await redis.setex(ck, 60 * 60, JSON.stringify(suggestions));
    } catch (err) {
      logger.warn(`smartReply cache write: ${(err as Error).message}`);
    }
    return { suggestions, usedAi: true, cached: false };
  } catch (err) {
    logger.warn(`smartReply failed: ${(err as Error).message}`);
    return { suggestions: heuristic(), usedAi: false, cached: false };
  }
};
