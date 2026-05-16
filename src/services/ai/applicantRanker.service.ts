import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { IJob } from '../../models/Job';
import { generateJson, isAiEnabled } from './providers';

/**
 * Hirer-side applicant ranker. Given a job + a slice of applications,
 * asks the AI to rank candidates and produce one-line strengths /
 * concerns each. Used by the hirer applicant list to surface the top
 * candidates without scrolling through every row.
 *
 * Caching: 6h Redis cache keyed by sha256(jobId + jobUpdatedAt + sorted
 * applicationIds). Same job + same applicant set re-ranks for free until
 * the job description changes or a new applicant arrives.
 *
 * Quota: ranking the whole batch counts as ONE quota slot, regardless of
 * batch size, so the hirer doesn't get charged per applicant.
 */

export interface RankableApplicant {
  applicationId: string;
  fullName: string;
  headline?: string;
  experienceYears?: number;
  skills: string[];
  resumeText?: string;
  /** Existing heuristic match (0-100) — fed to AI as a prior, not the answer. */
  heuristicMatch?: number;
}

export interface RankedApplicant {
  applicationId: string;
  aiScore: number;
  rank: number;
  summary: string;
  strengths: string[];
  concerns: string[];
}

export interface RankResult {
  rankings: RankedApplicant[];
  usedAi: boolean;
  cached: boolean;
  generatedAt: Date;
}

const cacheKey = (
  jobId: string,
  jobUpdatedAt: Date,
  applicationIds: string[],
): string => {
  const sorted = [...applicationIds].sort().join(',');
  const hash = crypto
    .createHash('sha256')
    .update(`${jobId}|${jobUpdatedAt.toISOString()}|${sorted}`)
    .digest('hex')
    .slice(0, 24);
  return `ai:rank:${hash}`;
};

const SYSTEM_PROMPT = `You are a senior recruiter ranking candidates for a job. Score each candidate 0-100 on fit, then list 1-3 strengths and 1-3 concerns. Output STRICT JSON only.

Score guide:
- 90+ : exceptional fit, strong yes
- 75-89: solid fit, recommend interview
- 60-74: marginal fit, depends on pipeline
- 40-59: weak fit, only if pipeline is dry
- <40 : poor fit

Rules:
- Be specific: cite actual skills/experience the candidate has, not generic platitudes.
- Concerns must be evidence-based (e.g. "no listed experience with X" — not "may not be a culture fit").
- Don't invent details the candidate didn't list.
- Order the output array by aiScore descending.

Schema:
{
  "rankings": [
    {
      "applicationId": "string from input",
      "aiScore": number (0-100),
      "summary": "one-sentence verdict, 12-20 words",
      "strengths": ["short bullets, 5-12 words each, max 3"],
      "concerns": ["short bullets, 5-12 words each, max 3"]
    }
  ]
}

Output ONLY the JSON, no markdown fences, no prose.`;

const buildUserPrompt = (
  job: Pick<IJob, 'title' | 'description' | 'skills'>,
  applicants: RankableApplicant[],
): string => {
  const jobBlock = [
    `Title: ${job.title}`,
    `Required skills: ${(job.skills ?? []).slice(0, 30).join(', ') || '(none listed)'}`,
    `Description: ${(job.description || '').slice(0, 3000)}`,
  ].join('\n');

  // Per-applicant block kept tight to fit the batch in one call. We trim
  // resume text aggressively because the LLM has the rest of the context
  // (skills, headline) and the bullets matter more than the full doc.
  const applicantBlocks = applicants
    .map((a, i) => {
      const skills = a.skills.slice(0, 20).join(', ') || '(none)';
      const resume = (a.resumeText || '').slice(0, 1200);
      return [
        `Candidate ${i + 1} (applicationId="${a.applicationId}"):`,
        `Name: ${a.fullName}`,
        a.headline ? `Headline: ${a.headline}` : null,
        a.experienceYears !== undefined
          ? `Experience: ${a.experienceYears} year${a.experienceYears === 1 ? '' : 's'}`
          : null,
        `Skills: ${skills}`,
        a.heuristicMatch !== undefined
          ? `(prior heuristic match: ${a.heuristicMatch})`
          : null,
        resume ? `Resume excerpt: ${resume}` : '(no resume text on file)',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return `JOB
${jobBlock}

CANDIDATES (${applicants.length})
${applicantBlocks}

Return the JSON now.`;
};

interface RawRanking {
  rankings?: Array<{
    applicationId?: unknown;
    aiScore?: unknown;
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
  parsed: RawRanking | null,
  validIds: Set<string>,
): RankedApplicant[] => {
  if (!parsed?.rankings || !Array.isArray(parsed.rankings)) return [];
  const seen = new Set<string>();
  const cleaned: RankedApplicant[] = [];
  for (const r of parsed.rankings) {
    const id = asString(r.applicationId, 30);
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    const score =
      typeof r.aiScore === 'number' && Number.isFinite(r.aiScore)
        ? Math.max(0, Math.min(100, Math.round(r.aiScore)))
        : 0;
    cleaned.push({
      applicationId: id,
      aiScore: score,
      rank: 0, // assigned below
      summary: asString(r.summary, 240),
      strengths: asStringArray(r.strengths),
      concerns: asStringArray(r.concerns),
    });
    seen.add(id);
  }
  cleaned.sort((a, b) => b.aiScore - a.aiScore);
  return cleaned.map((r, i) => ({ ...r, rank: i + 1 }));
};

/**
 * Heuristic fallback so the endpoint still returns useful data when no
 * AI provider is configured. Falls back to the supplied heuristicMatch
 * (or skill-overlap) and produces empty strengths/concerns.
 */
const heuristicRank = (
  job: Pick<IJob, 'skills'>,
  applicants: RankableApplicant[],
): RankedApplicant[] => {
  const jobSkills = (job.skills ?? []).map((s) => s.toLowerCase());
  const scored = applicants.map((a) => {
    const aSkills = new Set(a.skills.map((s) => s.toLowerCase()));
    const overlap = jobSkills.filter((s) => aSkills.has(s)).length;
    const fromOverlap = jobSkills.length
      ? Math.round((overlap / jobSkills.length) * 100)
      : 0;
    const score = a.heuristicMatch ?? fromOverlap;
    return {
      applicationId: a.applicationId,
      aiScore: score,
      rank: 0,
      summary: '',
      strengths: [],
      concerns: [],
    } satisfies RankedApplicant;
  });
  scored.sort((a, b) => b.aiScore - a.aiScore);
  return scored.map((r, i) => ({ ...r, rank: i + 1 }));
};

export interface RankApplicantsArgs {
  job: IJob;
  applicants: RankableApplicant[];
  userId: string;
}

/**
 * Cheap probe — controllers call this before `enforceQuota` so a cache
 * hit doesn't burn a quota slot.
 */
export const peekCachedRanking = async (
  jobId: string,
  jobUpdatedAt: Date,
  applicationIds: string[],
): Promise<RankedApplicant[] | null> => {
  if (applicationIds.length === 0) return null;
  try {
    const raw = await redis.get(cacheKey(jobId, jobUpdatedAt, applicationIds));
    if (!raw) return null;
    return JSON.parse(raw) as RankedApplicant[];
  } catch {
    return null;
  }
};

export const rankApplicants = async (
  args: RankApplicantsArgs,
): Promise<RankResult> => {
  const { job, applicants, userId } = args;
  const ids = applicants.map((a) => a.applicationId);
  const validIds = new Set(ids);

  if (applicants.length === 0) {
    return {
      rankings: [],
      usedAi: false,
      cached: false,
      generatedAt: new Date(),
    };
  }

  const ck = cacheKey(job._id.toString(), job.updatedAt, ids);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      return {
        rankings: JSON.parse(cached) as RankedApplicant[],
        usedAi: true,
        cached: true,
        generatedAt: new Date(),
      };
    }
  } catch (err) {
    logger.warn(`applicantRanker cache read failed: ${(err as Error).message}`);
  }

  if (!isAiEnabled()) {
    const fallback = heuristicRank(job, applicants);
    return {
      rankings: fallback,
      usedAi: false,
      cached: false,
      generatedAt: new Date(),
    };
  }

  try {
    const parsed = await generateJson<RawRanking>(
      {
        tier: 'smart',
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(job, applicants),
        maxTokens: 2000,
        temperature: 0.3,
      },
      { userId, feature: 'applicant_rank' },
    );

    const rankings = sanitize(parsed, validIds);
    if (rankings.length === 0) {
      // AI returned nothing usable — fall back to heuristic so the hirer
      // still sees a ranked list.
      return {
        rankings: heuristicRank(job, applicants),
        usedAi: false,
        cached: false,
        generatedAt: new Date(),
      };
    }

    try {
      await redis.setex(ck, 60 * 60 * 6, JSON.stringify(rankings));
    } catch (err) {
      logger.warn(
        `applicantRanker cache write failed: ${(err as Error).message}`,
      );
    }

    return {
      rankings,
      usedAi: true,
      cached: false,
      generatedAt: new Date(),
    };
  } catch (err) {
    logger.warn(`applicantRanker failed: ${(err as Error).message}`);
    return {
      rankings: heuristicRank(job, applicants),
      usedAi: false,
      cached: false,
      generatedAt: new Date(),
    };
  }
};
