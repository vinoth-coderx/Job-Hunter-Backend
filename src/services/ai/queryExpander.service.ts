import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generateJson, isProviderEnabled } from './providers';

/**
 * Lightweight semantic query expander. Given a natural-language job
 * search query, returns a list of synonyms / related terms that should
 * also recall matching listings.
 *
 * Examples:
 *   "react dev"        → ["reactjs", "react.js", "frontend developer"]
 *   "ML engineer"      → ["machine learning engineer", "MLE", "AI engineer"]
 *   "manual tester"    → ["QA tester", "quality assurance", "test engineer"]
 *
 * Plugs into `aiJobSearch` BEFORE the scope cascade — the synonyms get
 * folded into the intent's keyword pools, so a query that hits zero on
 * the literal terms still has expanded fallbacks before we drop the
 * freshness window or activity flag.
 *
 * Routed through Groq because the call is short, cheap, and benefits
 * from low latency (it gates the user-facing search response). Cached
 * for 7d in Redis since synonyms are stable.
 */

const cacheKey = (query: string): string => {
  const hash = crypto
    .createHash('sha256')
    .update(query.trim().toLowerCase())
    .digest('hex')
    .slice(0, 24);
  return `ai:qx:${hash}`;
};

const SYSTEM_PROMPT = `You expand a job search query into 3-8 SEARCH SYNONYMS that should also match relevant listings.

RULES:
- Output ONLY the JSON object. No markdown fences, no prose.
- Each synonym is a short phrase (1-4 words), lowercase.
- Include common abbreviations (e.g. "ml engineer" → "machine learning engineer", "mle").
- Include adjacent role titles when they share most of the work (e.g. "frontend developer" → "ui developer", "react developer").
- Skip the original query verbatim — only return ALTERNATIVE phrasings.
- Skip generic words ("developer", "engineer" alone) — they recall too much noise.
- For tech stacks include the canonical names ("react" → "reactjs", "react.js").
- Skip anything you're not confident about.

Schema:
{ "synonyms": ["...", "...", "..."] }`;

const sanitize = (raw: unknown): string[] => {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { synonyms?: unknown };
  if (!Array.isArray(obj.synonyms)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of obj.synonyms) {
    if (typeof s !== 'string') continue;
    const cleaned = s.trim().toLowerCase().slice(0, 60);
    if (cleaned.length < 2 || cleaned.length > 60) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= 8) break;
  }
  return out;
};

/**
 * Returns synonyms for the query, never the query itself. Empty list
 * when AI is unavailable or the call fails — callers should treat this
 * as a best-effort enhancement, not a requirement.
 */
export const expandQuery = async (query: string): Promise<string[]> => {
  const trimmed = (query || '').trim();
  if (trimmed.length < 2) return [];

  const ck = cacheKey(trimmed);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      try {
        return JSON.parse(cached) as string[];
      } catch {
        // fall through and recompute
      }
    }
  } catch (err) {
    logger.warn(`queryExpander cache read failed: ${(err as Error).message}`);
  }

  // Prefer Groq for the cheap-fast path; fall back to whichever provider
  // is configured (still cached for 7d so the cost is one call per query
  // per week). When NO provider is configured, return [] so the caller
  // continues with literal-only matching — the search still works.
  const preferred: 'groq' | undefined = isProviderEnabled('groq') ? 'groq' : undefined;

  try {
    const parsed = await generateJson<unknown>(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEM_PROMPT,
        user: `Query: "${trimmed.slice(0, 200)}"\n\nReturn the JSON now.`,
        json: true,
        maxTokens: 200,
        temperature: 0.4,
      },
      { feature: 'query_expand' },
    );

    const synonyms = sanitize(parsed).filter(
      (s) => s !== trimmed.toLowerCase(),
    );

    try {
      await redis.setex(ck, 60 * 60 * 24 * 7, JSON.stringify(synonyms));
    } catch (err) {
      logger.warn(
        `queryExpander cache write failed: ${(err as Error).message}`,
      );
    }
    return synonyms;
  } catch (err) {
    logger.warn(`queryExpander failed: ${(err as Error).message}`);
    return [];
  }
};
