import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { IUser } from '../../models/User';
import { IJob } from '../../models/Job';
import { redis } from '../../config/redis';

const client = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

const MODEL = 'claude-haiku-4-5-20251001';

export interface MatchResult {
  jobId: string;
  score: number;
  reasoning?: string;
  matchedSkills: string[];
  missingSkills: string[];
}

const cacheKey = (userId: string, jobId: string) => `match:${userId}:${jobId}`;

/// Weight breakdown (caps at 100):
///   Skills overlap        50
///   Role title match      15
///   Experience fit        15
///   Location match        10
///   Salary alignment       5
///   Job-type preference    3
///   Remote preference      2
///
/// Skills used to dominate at 70 — that pushed jobs with overlapping
/// keywords but mismatched seniority/salary to the top, which is why
/// "matches" felt off. Pulling skills down to 50 and giving experience +
/// salary + remote real weight tracks how a recruiter actually ranks.
export const heuristicMatch = (user: IUser, job: IJob): MatchResult => {
  const userSkills = (user.profile.skills || []).map((s) => s.toLowerCase());
  const jobSkills = (job.skills || []).map((s) => s.toLowerCase());
  const desc = job.description.toLowerCase();

  const matched = userSkills.filter(
    (s) => jobSkills.includes(s) || desc.includes(s),
  );
  const missing = jobSkills.filter((s) => !userSkills.includes(s));

  let score = 0;
  if (jobSkills.length > 0) {
    score = (matched.length / jobSkills.length) * 50;
  } else if (userSkills.length > 0) {
    const overlap = userSkills.filter((s) => desc.includes(s)).length;
    score = (overlap / userSkills.length) * 50;
  }

  const userRoles = (user.profile.preferredRoles || []).map((r) => r.toLowerCase());
  if (userRoles.some((r) => job.title.toLowerCase().includes(r))) score += 15;

  // Experience fit — full credit when the candidate sits inside the job's
  // band, partial when they're within 2 years on either side, zero when
  // the gap is larger or the band is unknown. Avoids the "junior matches
  // a staff role at 95%" failure mode.
  const exp = user.profile.experienceYears ?? 0;
  const expMin = job.experienceMinYears;
  const expMax = job.experienceMaxYears;
  if (typeof expMin === 'number' || typeof expMax === 'number') {
    const lo = expMin ?? 0;
    const hi = expMax ?? Math.max(lo, exp);
    if (exp >= lo && exp <= hi) {
      score += 15;
    } else {
      const gap = exp < lo ? lo - exp : exp - hi;
      if (gap <= 2) score += 8;
      else if (gap <= 4) score += 3;
    }
  }

  const userLocs = (user.profile.preferredLocations || []).map((l) => l.toLowerCase());
  if (
    userLocs.some(
      (l) => job.location.toLowerCase().includes(l) || (l === 'remote' && job.remoteType === 'remote'),
    )
  ) {
    score += 10;
  }

  // Salary alignment — only awards when both the candidate and the job
  // exposed a number. Full credit if the candidate's expected min sits
  // inside the job's range; partial when the job exceeds expectations
  // (a positive surprise); zero when the job offers materially less.
  const expected = user.profile.expectedSalaryMin;
  const jobMin = job.salaryMin;
  const jobMax = job.salaryMax;
  if (typeof expected === 'number' && (typeof jobMin === 'number' || typeof jobMax === 'number')) {
    const offerHi = jobMax ?? jobMin ?? 0;
    const offerLo = jobMin ?? jobMax ?? 0;
    if (expected <= offerHi && expected >= offerLo * 0.9) {
      score += 5;
    } else if (offerHi >= expected) {
      score += 3;
    }
  }

  if (
    user.profile.preferredJobTypes?.length &&
    user.profile.preferredJobTypes.includes(job.jobType)
  ) {
    score += 3;
  }

  if (
    user.profile.preferredRemote?.length &&
    user.profile.preferredRemote.includes(job.remoteType)
  ) {
    score += 2;
  }

  return {
    jobId: job._id.toString(),
    score: Math.min(100, Math.round(score)),
    matchedSkills: matched,
    missingSkills: missing.slice(0, 5),
  };
};

export const aiMatch = async (user: IUser, job: IJob): Promise<MatchResult> => {
  const cached = await redis.get(cacheKey(user._id.toString(), job._id.toString()));
  if (cached) return JSON.parse(cached) as MatchResult;

  if (!client) {
    const heuristic = heuristicMatch(user, job);
    await redis.setex(cacheKey(user._id.toString(), job._id.toString()), 86400, JSON.stringify(heuristic));
    return heuristic;
  }

  try {
    const profileText = `
Name: ${user.profile.fullName}
Headline: ${user.profile.headline || 'N/A'}
Experience: ${user.profile.experienceYears} years
Skills: ${(user.profile.skills || []).join(', ') || 'N/A'}
Preferred Roles: ${(user.profile.preferredRoles || []).join(', ') || 'N/A'}
Preferred Locations: ${(user.profile.preferredLocations || []).join(', ') || 'N/A'}
Preferred Job Types: ${(user.profile.preferredJobTypes || []).join(', ') || 'N/A'}
Resume Excerpt: ${(user.profile.resumeText || '').slice(0, 1500)}
`.trim();

    const jobText = `
Title: ${job.title}
Company: ${job.company}
Location: ${job.location} (${job.remoteType})
Job Type: ${job.jobType}
Required Skills: ${(job.skills || []).join(', ')}
Description: ${job.description.slice(0, 2000)}
`.trim();

    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: [
        {
          type: 'text',
          text: 'You are a career matching expert. Score how well a candidate matches a job from 0-100 based on skills, experience, role fit, and location. Return strict JSON only.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Score the candidate-job match.

CANDIDATE PROFILE:
${profileText}

JOB:
${jobText}

Return JSON only with this exact shape:
{"score": <0-100>, "reasoning": "<one short sentence>", "matchedSkills": ["..."], "missingSkills": ["..."]}`,
        },
      ],
    });

    const block = response.content[0];
    const text = block.type === 'text' ? block.text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]) as {
      score: number;
      reasoning?: string;
      matchedSkills?: string[];
      missingSkills?: string[];
    };

    const result: MatchResult = {
      jobId: job._id.toString(),
      score: Math.max(0, Math.min(100, Math.round(parsed.score))),
      reasoning: parsed.reasoning,
      matchedSkills: parsed.matchedSkills || [],
      missingSkills: parsed.missingSkills || [],
    };

    await redis.setex(cacheKey(user._id.toString(), job._id.toString()), 86400, JSON.stringify(result));
    return result;
  } catch (err) {
    logger.warn('AI match failed, using heuristic fallback', err);
    return heuristicMatch(user, job);
  }
};

export const matchJobsForUser = async (
  user: IUser,
  jobs: IJob[],
  threshold = env.AI_MATCH_THRESHOLD,
  useAi = false,
): Promise<Array<{ job: IJob; match: MatchResult }>> => {
  const matcher = useAi && client ? aiMatch : async (u: IUser, j: IJob) => heuristicMatch(u, j);

  const matched: Array<{ job: IJob; match: MatchResult }> = [];
  const concurrency = useAi ? 5 : 50;

  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (j) => ({ job: j, match: await matcher(user, j) })),
    );
    for (const r of results) {
      if (r.match.score >= threshold) matched.push(r);
    }
  }

  matched.sort((a, b) => b.match.score - a.match.score);
  return matched;
};
