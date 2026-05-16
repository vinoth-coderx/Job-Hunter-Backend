import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generateJson, isProviderEnabled } from './providers';
import { cleanPromptText } from './promptGuard.service';

/**
 * AI polish for a hirer's JD draft. Rewrites the description for
 * clarity, structure, and inclusive language WITHOUT inventing new
 * requirements or changing the core role. Returns the polished body
 * plus a short list of changes applied.
 *
 * Routed through Groq for speed/cost. Cached 24h server-side by
 * sha256(title + description). Returns the original on parse failure
 * so the hirer never gets blocked by a flaky AI response.
 */

export interface JdPolishResult {
  polished: string;
  changes: string[];
  usedAi: boolean;
  cached: boolean;
}

const cacheKey = (title: string, description: string): string => {
  const hash = crypto
    .createHash('sha256')
    .update(`${title.toLowerCase().trim()}||${description}`)
    .digest('hex')
    .slice(0, 24);
  return `ai:jdpolish:${hash}`;
};

const SYSTEM_PROMPT = `You polish a hiring manager's job description draft. Your job is to make it CLEARER, MORE INCLUSIVE, and BETTER STRUCTURED — never to change the substance or invent requirements.

RULES:
- Output STRICT JSON: {"polished": "...", "changes": ["...", "..."]}.
- "polished": the rewritten description as plain text. Keep paragraph breaks. Length within ±25% of the input.
- "changes": 2-5 short bullets explaining what you fixed (e.g. "split monolithic paragraph into responsibilities + qualifications").
- DO add: clear "Responsibilities", "Requirements", "Nice to have" sections when the input is one big blob.
- DO replace gendered words ("salesman" → "salesperson", "manpower" → "workforce").
- DO replace ageist filters ("digital native", "young & energetic") with skill-based equivalents.
- DO break long run-on sentences into shorter ones.
- DON'T add new skills, technologies, salary, or location not in the original.
- DON'T change the seniority level or role title.
- DON'T add marketing fluff ("rockstar", "exciting opportunity", "fast-paced").
- If the original is already great, return it unchanged with an empty changes array.
- Output ONLY the JSON, no markdown fences, no prose.`;

const sanitize = (raw: unknown, fallback: string): JdPolishResult => {
  if (!raw || typeof raw !== 'object') {
    return { polished: fallback, changes: [], usedAi: false, cached: false };
  }
  const obj = raw as { polished?: unknown; changes?: unknown };
  const polished =
    typeof obj.polished === 'string' && obj.polished.trim().length > 50
      ? obj.polished.trim().slice(0, 20000)
      : '';
  if (!polished) {
    return { polished: fallback, changes: [], usedAi: false, cached: false };
  }
  const changes: string[] = Array.isArray(obj.changes)
    ? obj.changes
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.trim().slice(0, 200))
        .filter((c) => c.length > 0)
        .slice(0, 5)
    : [];
  return { polished, changes, usedAi: true, cached: false };
};

export interface PolishJdArgs {
  title: string;
  description: string;
  userId?: string;
}

export const peekCachedPolishedJd = async (
  title: string,
  description: string,
): Promise<JdPolishResult | null> => {
  if (!description || description.length < 50) return null;
  try {
    const raw = await redis.get(cacheKey(title, description));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Pick<
      JdPolishResult,
      'polished' | 'changes'
    >;
    return { ...parsed, usedAi: true, cached: true };
  } catch {
    return null;
  }
};

export const polishJd = async (args: PolishJdArgs): Promise<JdPolishResult> => {
  // Strip prompt-injection markers before caching so a sanitised + raw
  // copy don't share a key — and so the model never sees the override.
  const description = cleanPromptText(
    args.description,
    'jd_polish',
    args.userId,
  ).trim();
  if (description.length < 50) {
    return { polished: description, changes: [], usedAi: false, cached: false };
  }

  const ck = cacheKey(args.title, description);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      const parsed = JSON.parse(cached) as Pick<
        JdPolishResult,
        'polished' | 'changes'
      >;
      return { ...parsed, usedAi: true, cached: true };
    }
  } catch (err) {
    logger.warn(`jdPolish cache read: ${(err as Error).message}`);
  }

  const preferred: 'groq' | undefined = isProviderEnabled('groq')
    ? 'groq'
    : undefined;
  if (
    !preferred &&
    !isProviderEnabled('gemini') &&
    !isProviderEnabled('claude')
  ) {
    return { polished: description, changes: [], usedAi: false, cached: false };
  }

  try {
    const parsed = await generateJson<unknown>(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEM_PROMPT,
        user: `Job title: ${args.title}\n\nDescription:\n"""\n${description.slice(0, 12000)}\n"""\n\nReturn the JSON now.`,
        json: true,
        maxTokens: 2000,
        temperature: 0.4,
      },
      { userId: args.userId, feature: 'jd_polish' },
    );

    const result = sanitize(parsed, description);
    if (!result.usedAi) return result;

    try {
      await redis.setex(
        ck,
        60 * 60 * 24,
        JSON.stringify({ polished: result.polished, changes: result.changes }),
      );
    } catch (err) {
      logger.warn(`jdPolish cache write: ${(err as Error).message}`);
    }
    return result;
  } catch (err) {
    logger.warn(`jdPolish failed: ${(err as Error).message}`);
    return { polished: description, changes: [], usedAi: false, cached: false };
  }
};
