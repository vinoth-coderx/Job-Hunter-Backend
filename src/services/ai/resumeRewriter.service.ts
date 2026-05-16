import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generate, isProviderEnabled } from './providers';
import { cleanPromptText } from './promptGuard.service';

/**
 * Resume rewriter — turns user-supplied resume text into ATS-tuned,
 * action-verb-led prose. Routed through Groq (Llama 3.x) by default
 * because the rewrite is short, cheap, and benefits from low latency;
 * falls back to whichever provider is enabled when Groq isn't.
 *
 * Three flavours, all sharing the same call shape:
 *   - bullet       : a single resume bullet → tightened achievement bullet
 *   - summary      : current professional summary → polished version
 *   - achievement  : raw "what I did" sentence → quantified achievement bullet
 *
 * Caching: 24h Redis cache keyed by (kind, hash(text + role + tone)) so
 * the same input bypasses both the AI call and the quota slot. Cache
 * misses count as one quota slot at the controller layer.
 */

export type RewriteKind = 'bullet' | 'summary' | 'achievement';
export type RewriteTone = 'professional' | 'concise' | 'impactful';

export interface RewriteResult {
  text: string;
  alternates: string[];
  usedAi: boolean;
  cached: boolean;
}

const cacheKey = (
  kind: RewriteKind,
  text: string,
  role?: string,
  tone?: RewriteTone,
): string => {
  const hash = crypto
    .createHash('sha256')
    .update(`${kind}|${text}|${role ?? ''}|${tone ?? ''}`)
    .digest('hex')
    .slice(0, 24);
  return `ai:rewrite:${hash}`;
};

const SYSTEMS: Record<RewriteKind, string> = {
  bullet: `You rewrite resume bullets so they pass ATS scanning and impress recruiters. RULES:
- Start with a strong past-tense action verb (Built, Led, Reduced, Shipped, Drove, etc.).
- Quantify with concrete numbers when the input contains them; never invent numbers.
- One sentence, 12-22 words, no period at the end.
- Remove filler ("responsible for", "tasked with", "duties included").
- Preserve the candidate's domain (don't change their tech stack or role).
Output STRICT JSON: {"text":"primary rewrite","alternates":["one alternative phrasing","another alternative phrasing"]}.
- Output ONLY the JSON, no markdown, no prose.`,
  summary: `You rewrite the "Professional Summary" / "About me" section of a resume. RULES:
- 2-4 sentences, 40-80 words total.
- Lead with the candidate's role + years of experience.
- Mention 2-3 strongest skills/specialties from their profile.
- End with the kind of impact or role they're seeking (only if signalled in the input).
- Plain prose, no bullet points, no first-person pronouns.
Output STRICT JSON: {"text":"primary rewrite","alternates":["one shorter version","one slightly different angle"]}.
- Output ONLY the JSON, no markdown, no prose.`,
  achievement: `You rewrite raw "what I did at work" sentences into quantified achievement bullets. RULES:
- Start with a past-tense verb.
- Show impact: who/what was helped, by how much (%/$/users/throughput).
- If the input has numbers, use them. If it doesn't, frame the impact qualitatively (don't fabricate numbers).
- Single sentence, 14-24 words, no trailing period.
Output STRICT JSON: {"text":"primary rewrite","alternates":["alternative phrasing","second alternative"]}.
- Output ONLY the JSON, no markdown, no prose.`,
};

const buildUserPrompt = (
  kind: RewriteKind,
  text: string,
  role?: string,
  tone?: RewriteTone,
): string => {
  const lines = [`Original ${kind}:\n"""${text.trim().slice(0, 1500)}"""`];
  if (role) lines.push(`Target role / domain: ${role.slice(0, 80)}`);
  if (tone) lines.push(`Preferred tone: ${tone}`);
  lines.push('Return the JSON now.');
  return lines.join('\n\n');
};

const parseRewrite = (raw: string): { text: string; alternates: string[] } | null => {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!cleaned) return null;
  try {
    const json = JSON.parse(cleaned) as { text?: unknown; alternates?: unknown };
    const text = typeof json.text === 'string' ? json.text.trim() : '';
    if (!text) return null;
    const alternates = Array.isArray(json.alternates)
      ? json.alternates
          .map((a) => (typeof a === 'string' ? a.trim() : ''))
          .filter((a) => a.length > 0 && a !== text)
          .slice(0, 3)
      : [];
    return { text: text.slice(0, 1000), alternates };
  } catch (err) {
    logger.warn(`resumeRewriter parse failed: ${(err as Error).message}`);
    return null;
  }
};

export interface RewriteOptions {
  kind: RewriteKind;
  text: string;
  role?: string;
  tone?: RewriteTone;
  userId?: string;
}

/**
 * Cheap cache probe — controllers call this before `enforceQuota` so a
 * cache hit doesn't burn a slot. Returns null when there's no cached
 * rewrite; the `text.length < 5` short-circuit also returns null.
 */
export const peekCachedRewrite = async (
  opts: Pick<RewriteOptions, 'kind' | 'text' | 'role' | 'tone'>,
): Promise<{ text: string; alternates: string[] } | null> => {
  const text = (opts.text || '').trim();
  if (text.length < 5) return null;
  try {
    const raw = await redis.get(cacheKey(opts.kind, text, opts.role, opts.tone));
    if (!raw) return null;
    return JSON.parse(raw) as { text: string; alternates: string[] };
  } catch {
    return null;
  }
};

export const rewriteResumeText = async (
  opts: RewriteOptions,
): Promise<RewriteResult> => {
  // Strip prompt-injection markers BEFORE caching — same key for guarded
  // and ungarded text would leak the redacted version, and skipping the
  // sanitiser would expose the model to the override tokens.
  const text = cleanPromptText(
    opts.text,
    `resume_rewrite:${opts.kind}`,
    opts.userId,
  ).trim();
  if (text.length < 5) {
    return { text, alternates: [], usedAi: false, cached: false };
  }

  const ck = cacheKey(opts.kind, text, opts.role, opts.tone);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      const parsed = JSON.parse(cached) as { text: string; alternates: string[] };
      return { ...parsed, usedAi: true, cached: true };
    }
  } catch (err) {
    logger.warn(`resumeRewriter cache read failed: ${(err as Error).message}`);
  }

  // Prefer Groq for the rewrite (cheap, fast). Fall back to whichever
  // provider is configured when Groq isn't.
  const preferred: 'groq' | undefined = isProviderEnabled('groq') ? 'groq' : undefined;

  try {
    const res = await generate(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEMS[opts.kind],
        user: buildUserPrompt(opts.kind, text, opts.role, opts.tone),
        json: true,
        maxTokens: 600,
        temperature: 0.55,
      },
      { userId: opts.userId, feature: `resume_rewrite:${opts.kind}` },
    );

    const parsed = parseRewrite(res.text);
    if (!parsed) {
      return { text, alternates: [], usedAi: false, cached: false };
    }

    try {
      await redis.setex(ck, 60 * 60 * 24, JSON.stringify(parsed));
    } catch (err) {
      logger.warn(`resumeRewriter cache write failed: ${(err as Error).message}`);
    }

    return { ...parsed, usedAi: true, cached: false };
  } catch (err) {
    logger.warn(`resumeRewriter failed: ${(err as Error).message}`);
    return { text, alternates: [], usedAi: false, cached: false };
  }
};
