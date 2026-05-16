import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { IJob } from '../../models/Job';
import { generateJson, isAiEnabled } from './providers';

/**
 * "Suggested candidates" service for hirers.
 *
 * Given a job + a candidate pool (typically past applicants who applied
 * to this hirer's other jobs), rank the pool against the job and return
 * the top-fit candidates with one-line strengths/concerns each.
 *
 * Distinct from `applicantRanker` which operates on existing application
 * documents — suggestions surface USERS (e.g. silver-medalists from a
 * previous role) the hirer can proactively reach out to.
 *
 * Cache key includes the job's updatedAt + the sorted userId list so
 * stable pools don't burn quota across views. Heuristic fallback uses
 * skill overlap when AI is unavailable.
 */

export interface SuggestableCandidate {
  userId: string;
  fullName: string;
  headline?: string;
  experienceYears?: number;
  skills: string[];
  resumeText?: string;
  /** How recently they applied to one of the hirer's other jobs, ISO. */
  lastSeenAt?: string;
}

export interface SuggestedCandidate {
  userId: string;
  score: number;
  rank: number;
  summary: string;
  strengths: string[];
  concerns: string[];
}

export interface SuggestionResult {
  suggestions: SuggestedCandidate[];
  usedAi: boolean;
  cached: boolean;
  poolSize: number;
  generatedAt: Date;
}

const cacheKey = (
  jobId: string,
  jobUpdatedAt: Date,
  userIds: string[],
): string => {
  const sorted = [...userIds].sort().join(',');
  const hash = crypto
    .createHash('sha256')
    .update(`${jobId}|${jobUpdatedAt.toISOString()}|${sorted}`)
    .digest('hex')
    .slice(0, 24);
  return `ai:csugg:${hash}`;
};

const SYSTEM_PROMPT = `You're a senior recruiter scanning a candidate pool for fit against a specific job. Score each candidate 0-100 and explain the recommendation in one sentence + bullets.

Score guide:
- 90+: exceptional fit, reach out today
- 75-89: strong fit, worth a recruiter ping
- 60-74: marginal, only if pipeline is thin
- 40-59: weak, skip
- <40: not a fit

Rules:
- Order output by score descending.
- Be specific: cite the candidate's actual skills/experience that match the job's requirements.
- Concerns must be evidence-based ("no listed AWS experience" — not "may not be senior enough").
- Don't invent details the candidate didn't list.
- If a candidate is below 40, omit them from the output entirely — only surface real fits.

Output STRICT JSON:
{
  "suggestions": [
    {
      "userId": "string from input",
      "score": number (40-100),
      "summary": "one-sentence verdict, 12-20 words",
      "strengths": ["short bullets, 5-12 words each, max 3"],
      "concerns": ["short bullets, 5-12 words each, max 3"]
    }
  ]
}

Output ONLY the JSON, no markdown fences, no prose.`;

const buildUserPrompt = (
  job: Pick<IJob, 'title' | 'description' | 'skills'>,
  pool: SuggestableCandidate[],
): string => {
  const jobBlock = [
    `Title: ${job.title}`,
    `Required skills: ${(job.skills ?? []).slice(0, 30).join(', ') || '(none listed)'}`,
    `Description: ${(job.description || '').slice(0, 3000)}`,
  ].join('\n');

  const candidates = pool
    .map((c, i) => {
      const skills = c.skills.slice(0, 20).join(', ') || '(none)';
      const resume = (c.resumeText || '').slice(0, 1200);
      return [
        `Candidate ${i + 1} (userId="${c.userId}"):`,
        `Name: ${c.fullName}`,
        c.headline ? `Headline: ${c.headline}` : null,
        c.experienceYears !== undefined
          ? `Experience: ${c.experienceYears} year${c.experienceYears === 1 ? '' : 's'}`
          : null,
        `Skills: ${skills}`,
        c.lastSeenAt ? `Last applied: ${c.lastSeenAt}` : null,
        resume ? `Resume excerpt: ${resume}` : '(no resume on file)',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return `JOB
${jobBlock}

CANDIDATE POOL (${pool.length})
${candidates}

Return the JSON now.`;
};

interface RawSuggestions {
  suggestions?: Array<{
    userId?: unknown;
    score?: unknown;
    summary?: unknown;
    strengths?: unknown;
    concerns?: unknown;
  }>;
}

const asString = (v: unknown, max = 240): string =>
  (typeof v === 'string' ? v : '').trim().slice(0, max);

const asStringArray = (v: unknown, max = 3, itemMax = 80): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => asString(x, itemMax))
    .filter((s) => s.length > 0)
    .slice(0, max);
};

const sanitize = (
  parsed: RawSuggestions | null,
  validIds: Set<string>,
): SuggestedCandidate[] => {
  if (!parsed?.suggestions || !Array.isArray(parsed.suggestions)) return [];
  const seen = new Set<string>();
  const out: SuggestedCandidate[] = [];
  for (const r of parsed.suggestions) {
    const id = asString(r.userId, 30);
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    const score =
      typeof r.score === 'number' && Number.isFinite(r.score)
        ? Math.max(0, Math.min(100, Math.round(r.score)))
        : 0;
    // Drop weak matches at the API layer too — defence-in-depth against
    // a model that ignores the "omit <40" rule in the system prompt.
    if (score < 40) continue;
    out.push({
      userId: id,
      score,
      rank: 0,
      summary: asString(r.summary, 240),
      strengths: asStringArray(r.strengths),
      concerns: asStringArray(r.concerns),
    });
    seen.add(id);
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((s, i) => ({ ...s, rank: i + 1 }));
};

/** Skill-overlap fallback when AI is unavailable. Drops everyone below
 *  a minimal threshold so the hirer doesn't see noise. */
const heuristicSuggest = (
  job: Pick<IJob, 'skills'>,
  pool: SuggestableCandidate[],
): SuggestedCandidate[] => {
  const jobSkills = new Set((job.skills ?? []).map((s) => s.toLowerCase()));
  if (jobSkills.size === 0) return [];
  const scored = pool
    .map((c) => {
      const candSkills = c.skills.map((s) => s.toLowerCase());
      const overlap = candSkills.filter((s) => jobSkills.has(s)).length;
      const score = Math.round((overlap / jobSkills.size) * 100);
      return { c, score };
    })
    .filter((x) => x.score >= 40);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 10).map(({ c, score }, i) => ({
    userId: c.userId,
    score,
    rank: i + 1,
    summary: '',
    strengths: [],
    concerns: [],
  }));
};

export interface SuggestArgs {
  job: IJob;
  pool: SuggestableCandidate[];
  userId: string;
  /** Cap on returned suggestions; defaults to 10. */
  limit?: number;
}

/** Cheap probe — controllers use this before enforceQuota. */
export const peekCachedSuggestions = async (
  jobId: string,
  jobUpdatedAt: Date,
  userIds: string[],
): Promise<SuggestedCandidate[] | null> => {
  if (userIds.length === 0) return null;
  try {
    const raw = await redis.get(cacheKey(jobId, jobUpdatedAt, userIds));
    if (!raw) return null;
    return JSON.parse(raw) as SuggestedCandidate[];
  } catch {
    return null;
  }
};

export const suggestCandidates = async (
  args: SuggestArgs,
): Promise<SuggestionResult> => {
  const { job, pool, userId } = args;
  const limit = Math.max(1, Math.min(20, args.limit ?? 10));
  const validIds = new Set(pool.map((c) => c.userId));

  if (pool.length === 0) {
    return {
      suggestions: [],
      usedAi: false,
      cached: false,
      poolSize: 0,
      generatedAt: new Date(),
    };
  }

  const ids = pool.map((c) => c.userId);
  const ck = cacheKey(job._id.toString(), job.updatedAt, ids);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      const parsed = JSON.parse(cached) as SuggestedCandidate[];
      return {
        suggestions: parsed.slice(0, limit),
        usedAi: true,
        cached: true,
        poolSize: pool.length,
        generatedAt: new Date(),
      };
    }
  } catch (err) {
    logger.warn(
      `candidateSuggester cache read failed: ${(err as Error).message}`,
    );
  }

  if (!isAiEnabled()) {
    return {
      suggestions: heuristicSuggest(job, pool).slice(0, limit),
      usedAi: false,
      cached: false,
      poolSize: pool.length,
      generatedAt: new Date(),
    };
  }

  try {
    const parsed = await generateJson<RawSuggestions>(
      {
        tier: 'smart',
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(job, pool),
        maxTokens: 2000,
        temperature: 0.3,
      },
      { userId, feature: 'candidate_suggest' },
    );

    const suggestions = sanitize(parsed, validIds);
    if (suggestions.length === 0) {
      // AI returned nothing usable → heuristic fallback so the hirer
      // still gets a populated list.
      return {
        suggestions: heuristicSuggest(job, pool).slice(0, limit),
        usedAi: false,
        cached: false,
        poolSize: pool.length,
        generatedAt: new Date(),
      };
    }

    try {
      await redis.setex(ck, 60 * 60 * 6, JSON.stringify(suggestions));
    } catch (err) {
      logger.warn(
        `candidateSuggester cache write failed: ${(err as Error).message}`,
      );
    }

    return {
      suggestions: suggestions.slice(0, limit),
      usedAi: true,
      cached: false,
      poolSize: pool.length,
      generatedAt: new Date(),
    };
  } catch (err) {
    logger.warn(`candidateSuggester failed: ${(err as Error).message}`);
    return {
      suggestions: heuristicSuggest(job, pool).slice(0, limit),
      usedAi: false,
      cached: false,
      poolSize: pool.length,
      generatedAt: new Date(),
    };
  }
};
