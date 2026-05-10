import { logger } from '../../../utils/logger';
import { IJob } from '../../../models/Job';
import { IUser } from '../../../models/User';
import { generateJson } from '../providers';

/**
 * One-shot job insight pipeline.
 *
 * When a user opens a job (or hits "Apply"), we run a single Gemini "smart"
 * call that returns:
 *   1. matchScore   → 0-100 with reasoning
 *   2. coverLetter  → tailored opening + body
 *   3. skillGap     → missing skills + ramp-up suggestions
 *   4. interviewPrep→ 3 likely first-round questions
 *
 * Replaces what used to be 3 separate calls (matcher + coverLetter +
 * skillGap). One quota slot, one context build, ~3x throughput on free tier.
 */

export interface JobInsight {
  matchScore: {
    score: number;
    reasoning: string;
    matchedSkills: string[];
    missingSkills: string[];
  };
  coverLetter: {
    opening: string;
    body: string;
  };
  skillGap: {
    missing: Array<{ skill: string; priority: 'high' | 'medium' | 'low'; rampUp: string }>;
    summary: string;
  };
  interviewPrep: Array<{ question: string; whyAsked: string }>;
}

const compactProfile = (user: IUser): string =>
  [
    `Name: ${user.profile.fullName}`,
    `Headline: ${user.profile.headline || 'N/A'}`,
    `Experience: ${user.profile.experienceYears ?? 0} years`,
    `Skills: ${(user.profile.skills || []).slice(0, 30).join(', ') || 'N/A'}`,
    `Preferred Roles: ${(user.profile.preferredRoles || []).join(', ') || 'N/A'}`,
    `Resume Excerpt: ${(user.profile.resumeText || '').slice(0, 1500)}`,
  ].join('\n');

const compactJob = (job: IJob): string =>
  [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location} (${job.remoteType})`,
    `Type: ${job.jobType}`,
    `Experience: ${job.experienceMinYears ?? '?'}-${job.experienceMaxYears ?? '?'} years`,
    `Required Skills: ${(job.skills || []).join(', ')}`,
    `Description: ${(job.description || '').slice(0, 1800)}`,
  ].join('\n');

const SYSTEM_PROMPT = `You are a career assistant producing one consolidated insight for a candidate viewing a single job. Output STRICT JSON, no prose, no markdown fences.

Schema:
{
  "matchScore": {
    "score": <0-100>,
    "reasoning": "<one sentence on why this score>",
    "matchedSkills": ["candidate skills aligned with the job"],
    "missingSkills": ["job skills candidate lacks, max 5"]
  },
  "coverLetter": {
    "opening": "<2-3 sentence personalised opener referencing the company and role>",
    "body": "<3-5 sentence body highlighting fit, top 2 relevant achievements, and intent>"
  },
  "skillGap": {
    "missing": [
      { "skill": "<name>", "priority": "high|medium|low", "rampUp": "<one short ramp-up suggestion>" }
    ],
    "summary": "<one sentence summary of the gap>"
  },
  "interviewPrep": [
    { "question": "<likely first-round question>", "whyAsked": "<one short reason this would be asked>" }
  ]
}

Rules:
- coverLetter must be specific to THIS company and role — never generic boilerplate.
- coverLetter must NOT invent achievements; only reference what's in the resume.
- interviewPrep returns exactly 3 items.
- skillGap.missing returns at most 5 items, ordered by priority desc.
- Tone: professional, confident, no hype words ("synergy", "rockstar", etc.).`;

export const runJobInsight = async (
  user: IUser,
  job: IJob,
): Promise<JobInsight | null> => {
  const userPrompt = `CANDIDATE PROFILE:
${compactProfile(user)}

JOB:
${compactJob(job)}

Return the JSON now.`;

  try {
    const result = await generateJson<JobInsight>({
      tier: 'smart',
      system: SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: 2500,
      temperature: 0.4,
    });
    if (!result) return null;
    return sanitize(result);
  } catch (err) {
    logger.warn(`runJobInsight failed: ${(err as Error).message}`);
    throw err;
  }
};

const asString = (v: unknown, max = 400): string =>
  (typeof v === 'string' ? v : '').trim().slice(0, max);

const asInt = (v: unknown, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(min, Math.min(max, n));
};

const validPriority = (v: unknown): 'high' | 'medium' | 'low' => {
  const s = asString(v, 10).toLowerCase();
  if (s === 'high' || s === 'medium' || s === 'low') return s;
  return 'medium';
};

const sanitize = (raw: JobInsight): JobInsight => {
  const ms = raw.matchScore || ({} as JobInsight['matchScore']);
  const cl = raw.coverLetter || ({} as JobInsight['coverLetter']);
  const sg = raw.skillGap || ({} as JobInsight['skillGap']);
  const ipIn: unknown[] = Array.isArray(raw.interviewPrep) ? raw.interviewPrep : [];
  const missingIn: unknown[] = Array.isArray(sg.missing) ? sg.missing : [];

  return {
    matchScore: {
      score: asInt(ms.score, 0, 100),
      reasoning: asString(ms.reasoning, 300),
      matchedSkills: Array.isArray(ms.matchedSkills)
        ? ms.matchedSkills.map((s) => asString(s, 60)).filter(Boolean).slice(0, 10)
        : [],
      missingSkills: Array.isArray(ms.missingSkills)
        ? ms.missingSkills.map((s) => asString(s, 60)).filter(Boolean).slice(0, 5)
        : [],
    },
    coverLetter: {
      opening: asString(cl.opening, 600),
      body: asString(cl.body, 2000),
    },
    skillGap: {
      missing: missingIn
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .map((m) => ({
          skill: asString(m.skill, 60),
          priority: validPriority(m.priority),
          rampUp: asString(m.rampUp, 200),
        }))
        .filter((m) => m.skill.length > 0)
        .slice(0, 5),
      summary: asString(sg.summary, 300),
    },
    interviewPrep: ipIn
      .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
      .map((q) => ({
        question: asString(q.question, 300),
        whyAsked: asString(q.whyAsked, 200),
      }))
      .filter((q) => q.question.length > 0)
      .slice(0, 3),
  };
};
