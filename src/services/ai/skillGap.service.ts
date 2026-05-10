import { logger } from '../../utils/logger';
import { IUser } from '../../models/User';
import { Job } from '../../models/Job';
import { redis } from '../../config/redis';
import { generateJson, isAiEnabled } from './providers';

export interface SkillGapResult {
  role: string;
  city?: string;
  jobsAnalyzed: number;
  matchedSkills: { skill: string; demandPercent: number }[];
  missingSkills: { skill: string; demandPercent: number }[];
  resources: SkillResource[];
  // 0–100 — heuristic readiness for the role.
  readinessScore: number;
  usedAi: boolean;
}

export interface SkillResource {
  skill: string;
  title: string;
  type: 'course' | 'book' | 'tutorial' | 'project';
  url?: string;
  estimatedHours?: number;
}

const cacheKey = (userId: string, role: string, city?: string) =>
  `skill-gap:${userId}:${role.toLowerCase()}:${(city ?? '').toLowerCase()}`;

/**
 * Mines top skills from active jobs matching the role + (optional) city,
 * compares to the user's profile skills, returns matched + missing, and
 * (when LLM is available) suggests learning resources for the top gaps.
 */
export const analyseSkillGap = async (
  user: IUser,
  role: string,
  city?: string,
): Promise<SkillGapResult> => {
  const id = user._id.toString();
  const ck = cacheKey(id, role, city);
  const cached = await redis.get(ck);
  if (cached) {
    try {
      return JSON.parse(cached) as SkillGapResult;
    } catch {
      // recompute
    }
  }

  const filter: Record<string, unknown> = {
    isActive: true,
    title: { $regex: role, $options: 'i' },
  };
  if (city && city.length > 0) {
    filter.location = { $regex: city, $options: 'i' };
  }

  const jobs = await Job.find(filter).select('skills title').limit(500).lean();

  // Tally skill frequency across jobs.
  const tally = new Map<string, number>();
  for (const j of jobs) {
    for (const raw of j.skills ?? []) {
      const s = (raw || '').toLowerCase().trim();
      if (!s) continue;
      tally.set(s, (tally.get(s) ?? 0) + 1);
    }
  }

  const userSkills = new Set(
    (user.profile.skills ?? []).map((s) => s.toLowerCase().trim()),
  );

  // Sort by demand desc, take top 25.
  const ranked = [...tally.entries()]
    .filter(([, n]) => n >= 2) // skip skills mentioned in only one job
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
  const totalJobsForDenom = jobs.length || 1;

  const matched: { skill: string; demandPercent: number }[] = [];
  const missing: { skill: string; demandPercent: number }[] = [];
  for (const [s, count] of ranked) {
    const pct = Math.round((count / totalJobsForDenom) * 100);
    if (userSkills.has(s)) {
      matched.push({ skill: s, demandPercent: pct });
    } else {
      missing.push({ skill: s, demandPercent: pct });
    }
  }

  // Readiness — % of top-demand skills the user has, weighted by demand.
  const totalDemand = ranked.reduce((sum, [, n]) => sum + n, 0);
  const matchedDemand = ranked
    .filter(([s]) => userSkills.has(s))
    .reduce((sum, [, n]) => sum + n, 0);
  const readinessScore =
    totalDemand > 0 ? Math.round((matchedDemand / totalDemand) * 100) : 0;

  let resources: SkillResource[] = [];
  let usedAi = false;
  if (isAiEnabled() && missing.length > 0) {
    try {
      const top = missing.slice(0, 6).map((m) => m.skill);
      const system = `Suggest concise learning resources to fill skill gaps for a Job seeker. Output strict JSON:
{"resources":[
  {"skill":"...","title":"...","type":"course"|"book"|"tutorial"|"project","url":"https://..." (optional),"estimatedHours":number (optional)}
]}
Rules: ONLY JSON, no prose. Up to 2 resources per skill, max 12 total. Prefer free / well-known options. URLs must be real (skip if unsure).`;
      const userPrompt = `Skills to fill: ${top.join(', ')}\nTarget role: ${role}\nCandidate experience: ${user.profile.experienceYears} years.`;
      const parsed = await generateJson<{ resources?: unknown }>({
        tier: 'lite',
        system,
        user: userPrompt,
        maxTokens: 900,
        temperature: 0.4,
      });
      if (parsed) {
        const arr = Array.isArray(parsed.resources) ? parsed.resources : [];
        resources = arr
          .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
          .slice(0, 12)
          .map((x) => ({
            skill: String(x.skill ?? '').toLowerCase().slice(0, 100),
            title: String(x.title ?? '').slice(0, 200),
            type: (['course', 'book', 'tutorial', 'project'].includes(x.type as string)
              ? x.type
              : 'course') as SkillResource['type'],
            url: typeof x.url === 'string' ? x.url.slice(0, 500) : undefined,
            estimatedHours:
              typeof x.estimatedHours === 'number'
                ? Math.max(1, Math.min(500, Math.round(x.estimatedHours)))
                : undefined,
          }))
          .filter((r) => r.skill.length > 0 && r.title.length > 2);
        usedAi = true;
      }
    } catch (err) {
      logger.warn(`skillGap LLM failed: ${(err as Error).message}`);
    }
  }

  const result: SkillGapResult = {
    role,
    city,
    jobsAnalyzed: jobs.length,
    matchedSkills: matched,
    missingSkills: missing,
    resources,
    readinessScore,
    usedAi,
  };

  // 12-hour cache — gap analysis is per-user-per-role.
  await redis.setex(ck, 60 * 60 * 12, JSON.stringify(result));
  return result;
};
