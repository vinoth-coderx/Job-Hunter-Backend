import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generateJson, isProviderEnabled } from './providers';
import { cleanPromptText } from './promptGuard.service';

/**
 * Lightweight skill extractor for arbitrary text — primarily a job
 * description, but works on resume snippets too. Returns a normalised
 * skill list with consistent casing so the matcher and search index
 * stay clean.
 *
 * Routed through Groq because the call is short and high-volume (every
 * JD write triggers it). 7d Redis cache keyed by sha256(text) so the
 * same JD only ever pays the rewrite once.
 *
 * NOT quota-charged at the controller — Groq is the cheap-fast lane.
 * Switching to Gemini would require re-introducing a weight; for now
 * `feature: 'skill_extract'` flows through the existing usage log so
 * cost shows up in admin analytics regardless.
 */

export interface ExtractedSkills {
  skills: string[];
  usedAi: boolean;
  cached: boolean;
}

const cacheKey = (text: string): string => {
  const hash = crypto
    .createHash('sha256')
    .update(text.trim().toLowerCase().slice(0, 8000))
    .digest('hex')
    .slice(0, 24);
  return `ai:skillx:${hash}`;
};

const SYSTEM_PROMPT = `You extract job-relevant SKILLS from a block of text. RULES:

- Output STRICT JSON only: {"skills": ["..."]}.
- Each skill is a short phrase (1-3 words).
- Use canonical casing for tech: "JavaScript", "TypeScript", "React", "Node.js", "PostgreSQL", "Kubernetes", "AWS", "GCP", "Azure".
- Use canonical casing for soft skills: "Communication", "Leadership", "Stakeholder Management".
- Deduplicate: pick ONE form ("react" / "reactjs" / "react.js" → "React").
- Drop generic nouns ("developer", "engineer", "team player").
- Drop product/company names that aren't skills (e.g. "Salesforce" stays — it's a known platform; "ACME Corp" doesn't).
- Skip anything not actually mentioned in the text.
- Return between 0 and 30 items, max.
- Output ONLY the JSON, no markdown fences, no prose.`;

const sanitize = (raw: unknown): string[] => {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { skills?: unknown };
  if (!Array.isArray(obj.skills)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of obj.skills) {
    if (typeof s !== 'string') continue;
    const cleaned = s.trim().slice(0, 60);
    if (cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 30) break;
  }
  return out;
};

export const extractSkills = async (
  text: string,
  opts: { userId?: string } = {},
): Promise<ExtractedSkills> => {
  // Cache the SANITISED text so a guarded + raw version don't share a
  // hash, and the model never sees the override tokens.
  const trimmed = cleanPromptText(text, 'skill_extract', opts.userId).trim();
  if (trimmed.length < 30) {
    return { skills: [], usedAi: false, cached: false };
  }

  const ck = cacheKey(trimmed);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      try {
        const skills = JSON.parse(cached) as string[];
        return { skills, usedAi: true, cached: true };
      } catch {
        // fall through and recompute
      }
    }
  } catch (err) {
    logger.warn(`skillExtractor cache read: ${(err as Error).message}`);
  }

  const preferred: 'groq' | undefined = isProviderEnabled('groq')
    ? 'groq'
    : undefined;
  if (!preferred && !isProviderEnabled('gemini') && !isProviderEnabled('claude')) {
    return { skills: [], usedAi: false, cached: false };
  }

  try {
    const parsed = await generateJson<unknown>(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEM_PROMPT,
        user: `Text:\n"""\n${trimmed.slice(0, 8000)}\n"""\n\nReturn the JSON now.`,
        json: true,
        maxTokens: 400,
        temperature: 0.2,
      },
      { userId: opts.userId, feature: 'skill_extract' },
    );

    const skills = sanitize(parsed);
    try {
      await redis.setex(ck, 60 * 60 * 24 * 7, JSON.stringify(skills));
    } catch (err) {
      logger.warn(`skillExtractor cache write: ${(err as Error).message}`);
    }
    return { skills, usedAi: true, cached: false };
  } catch (err) {
    logger.warn(`skillExtractor failed: ${(err as Error).message}`);
    return { skills: [], usedAi: false, cached: false };
  }
};
