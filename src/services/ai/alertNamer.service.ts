import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generateJson, isProviderEnabled } from './providers';

/**
 * AI alert-name suggester. Given a query + filters + location, returns
 * 2-3 short, human-friendly alert labels the seeker can pick from when
 * saving a search as an alert.
 *
 * Examples:
 *   query="senior react dev", location="bangalore"
 *     → ["Senior React in Bangalore", "Bangalore React roles", "React seniors"]
 *
 * Routed through Groq (cheap, fast). Cached 7d server-side by hash of
 * the inputs since the same filters always produce the same name.
 *
 * Heuristic fallback: when AI is unavailable, returns one mechanical
 * name built from the inputs so the UI always has something to suggest.
 */

export interface AlertNameInput {
  query: string;
  filters?: string[];
  location?: string;
}

const cacheKey = (input: AlertNameInput): string => {
  const filters = [...(input.filters ?? [])]
    .map((f) => f.toLowerCase().trim())
    .filter((f) => f.length > 0)
    .sort()
    .join(',');
  const hash = crypto
    .createHash('sha256')
    .update(
      `${input.query.toLowerCase().trim()}||${filters}||${(input.location ?? '').toLowerCase().trim()}`,
    )
    .digest('hex')
    .slice(0, 24);
  return `ai:alertname:${hash}`;
};

const SYSTEM_PROMPT = `You name a job-search alert so the user remembers what it tracks. Output STRICT JSON.

RULES:
- Output {"names": ["...", "...", "..."]}.
- 2-3 names. Each 3-6 words. Title Case.
- Lead with the role / skill, then location only if specified.
- No emoji. No marketing fluff. No exclamation marks.
- Don't repeat the literal query verbatim — that's already what the user typed.
- Don't invent details that aren't in the input.
- Output ONLY the JSON, no markdown fences, no prose.`;

const sanitize = (raw: unknown): string[] => {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { names?: unknown };
  if (!Array.isArray(obj.names)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of obj.names) {
    if (typeof n !== 'string') continue;
    const cleaned = n.trim().slice(0, 60);
    if (cleaned.length < 4) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 3) break;
  }
  return out;
};

const heuristic = (input: AlertNameInput): string[] => {
  const titleCase = (s: string): string =>
    s
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  const role = titleCase(input.query.trim());
  const loc = (input.location ?? '').trim();
  if (role && loc) return [`${role} in ${titleCase(loc)}`];
  if (role) return [role];
  if (loc) return [`${titleCase(loc)} jobs`];
  return ['New alert'];
};

export const suggestAlertNames = async (
  input: AlertNameInput,
  opts: { userId?: string } = {},
): Promise<string[]> => {
  const query = (input.query || '').trim();
  if (query.length === 0 && !(input.location ?? '').trim()) {
    return [];
  }

  const ck = cacheKey(input);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      const parsed = JSON.parse(cached) as string[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (err) {
    logger.warn(`alertNamer cache read: ${(err as Error).message}`);
  }

  const preferred: 'groq' | undefined = isProviderEnabled('groq')
    ? 'groq'
    : undefined;
  if (
    !preferred &&
    !isProviderEnabled('gemini')
  ) {
    return heuristic(input);
  }

  const userPrompt = [
    `Query: "${query}"`,
    input.filters && input.filters.length > 0
      ? `Filters: ${input.filters.slice(0, 12).join(', ')}`
      : null,
    input.location ? `Location: ${input.location}` : null,
    'Return the JSON now.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const parsed = await generateJson<unknown>(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEM_PROMPT,
        user: userPrompt,
        json: true,
        maxTokens: 150,
        temperature: 0.5,
      },
      { userId: opts.userId, feature: 'alert_name' },
    );

    const names = sanitize(parsed);
    if (names.length === 0) return heuristic(input);

    try {
      await redis.setex(ck, 60 * 60 * 24 * 7, JSON.stringify(names));
    } catch (err) {
      logger.warn(`alertNamer cache write: ${(err as Error).message}`);
    }
    return names;
  } catch (err) {
    logger.warn(`alertNamer failed: ${(err as Error).message}`);
    return heuristic(input);
  }
};
