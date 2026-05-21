import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generateJson, isProviderEnabled } from './providers';
import { cleanPromptText } from './promptGuard.service';

/**
 * One-click resume TL;DR for the hirer's applicant detail screen.
 *
 * Returns a 2-line summary the recruiter can scan in 5 seconds plus a
 * short list of "headline strengths" — the things this candidate brings
 * that match the kind of role they're applying for. Different from
 * `applicantRanker` (which produces a per-job verdict): this is just a
 * standalone resume digest, not pinned to any specific job.
 *
 * Routed through Groq (cheap-fast). Cached 30d server-side by hash of
 * the resume text — same resume re-opened never burns a fresh slot
 * even across multiple jobs / hirers.
 */

export interface ResumeTldr {
  summary: string;
  strengths: string[];
  yearsOfExperience: number | null;
  topRoles: string[];
  usedAi: boolean;
  cached: boolean;
}

const cacheKey = (resumeText: string): string => {
  const hash = crypto
    .createHash('sha256')
    .update(resumeText.trim().toLowerCase().slice(0, 12000))
    .digest('hex')
    .slice(0, 24);
  return `ai:tldr:${hash}`;
};

const SYSTEM_PROMPT = `You write a 2-line TL;DR of a candidate's resume for a busy recruiter. RULES:

- Output STRICT JSON: {"summary": "...", "strengths": ["...", "..."], "yearsOfExperience": 4, "topRoles": ["..."]}.
- "summary": exactly 2 sentences. First sentence: who they are (role + experience + standout context). Second sentence: what they're best at + any signal of trajectory.
- "strengths": 3-5 short bullets (4-10 words each), each citing a SPECIFIC capability the resume actually shows. NEVER invent.
- "yearsOfExperience": integer; infer from employment history if not stated. Null when truly unclear.
- "topRoles": 1-3 most-recent job titles (verbatim from resume).
- Don't invent skills, companies, or years.
- Don't editorialize ("impressive candidate", "would be great"). State facts.
- Output ONLY the JSON, no markdown fences, no prose.`;

const sanitize = (raw: unknown): Omit<ResumeTldr, 'usedAi' | 'cached'> | null => {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const summary =
    typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 600) : '';
  if (summary.length < 20) return null;
  const strengths = Array.isArray(obj.strengths)
    ? obj.strengths
        .map((s) => (typeof s === 'string' ? s.trim().slice(0, 140) : ''))
        .filter((s) => s.length >= 4)
        .slice(0, 5)
    : [];
  const years =
    typeof obj.yearsOfExperience === 'number' &&
    Number.isFinite(obj.yearsOfExperience) &&
    obj.yearsOfExperience >= 0 &&
    obj.yearsOfExperience <= 60
      ? Math.round(obj.yearsOfExperience)
      : null;
  const topRoles = Array.isArray(obj.topRoles)
    ? obj.topRoles
        .map((r) => (typeof r === 'string' ? r.trim().slice(0, 120) : ''))
        .filter((r) => r.length >= 2)
        .slice(0, 3)
    : [];
  return { summary, strengths, yearsOfExperience: years, topRoles };
};

export interface SummariseResumeArgs {
  resumeText: string;
  /** Hirer user id for usage logging — never the seeker's. */
  userId?: string;
}

export const summariseResume = async (
  args: SummariseResumeArgs,
): Promise<ResumeTldr> => {
  // Strip prompt-injection markers + trim before caching so a guarded /
  // raw copy can't shard the cache or hit the model with the override.
  const text = cleanPromptText(args.resumeText, 'resume_tldr', args.userId).trim();
  if (text.length < 100) {
    return {
      summary: 'Resume too short to summarise.',
      strengths: [],
      yearsOfExperience: null,
      topRoles: [],
      usedAi: false,
      cached: false,
    };
  }

  const ck = cacheKey(text);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      const parsed = JSON.parse(cached) as Omit<
        ResumeTldr,
        'usedAi' | 'cached'
      >;
      return { ...parsed, usedAi: true, cached: true };
    }
  } catch (err) {
    logger.warn(`resumeTldr cache read: ${(err as Error).message}`);
  }

  const preferred: 'groq' | undefined = isProviderEnabled('groq')
    ? 'groq'
    : undefined;
  if (
    !preferred &&
    !isProviderEnabled('gemini')
  ) {
    return {
      summary: 'AI summary unavailable.',
      strengths: [],
      yearsOfExperience: null,
      topRoles: [],
      usedAi: false,
      cached: false,
    };
  }

  try {
    const parsed = await generateJson<unknown>(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEM_PROMPT,
        user: `Resume text:\n"""${text.slice(0, 12000)}"""\n\nReturn the JSON now.`,
        json: true,
        maxTokens: 600,
        temperature: 0.3,
      },
      { userId: args.userId, feature: 'resume_tldr' },
    );

    const sane = sanitize(parsed);
    if (!sane) {
      return {
        summary: 'Could not generate summary from this resume.',
        strengths: [],
        yearsOfExperience: null,
        topRoles: [],
        usedAi: false,
        cached: false,
      };
    }

    try {
      await redis.setex(ck, 60 * 60 * 24 * 30, JSON.stringify(sane));
    } catch (err) {
      logger.warn(`resumeTldr cache write: ${(err as Error).message}`);
    }

    return { ...sane, usedAi: true, cached: false };
  } catch (err) {
    logger.warn(`resumeTldr failed: ${(err as Error).message}`);
    return {
      summary: 'Summary failed — try again.',
      strengths: [],
      yearsOfExperience: null,
      topRoles: [],
      usedAi: false,
      cached: false,
    };
  }
};

export const peekCachedTldr = async (
  resumeText: string,
): Promise<ResumeTldr | null> => {
  const text = (resumeText || '').trim();
  if (text.length < 100) return null;
  try {
    const cached = await redis.get(cacheKey(text));
    if (!cached) return null;
    const parsed = JSON.parse(cached) as Omit<ResumeTldr, 'usedAi' | 'cached'>;
    return { ...parsed, usedAi: true, cached: true };
  } catch {
    return null;
  }
};
