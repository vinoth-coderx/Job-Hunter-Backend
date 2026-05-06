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
    score = (matched.length / jobSkills.length) * 70;
  } else if (userSkills.length > 0) {
    const overlap = userSkills.filter((s) => desc.includes(s)).length;
    score = (overlap / userSkills.length) * 70;
  }

  const userRoles = (user.profile.preferredRoles || []).map((r) => r.toLowerCase());
  if (userRoles.some((r) => job.title.toLowerCase().includes(r))) score += 15;

  const userLocs = (user.profile.preferredLocations || []).map((l) => l.toLowerCase());
  if (
    userLocs.some(
      (l) => job.location.toLowerCase().includes(l) || (l === 'remote' && job.remoteType === 'remote'),
    )
  ) {
    score += 10;
  }

  if (
    user.profile.preferredJobTypes?.length &&
    user.profile.preferredJobTypes.includes(job.jobType)
  ) {
    score += 5;
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
