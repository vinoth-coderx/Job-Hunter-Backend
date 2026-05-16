import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generateJson, isProviderEnabled } from './providers';
import type { Types } from 'mongoose';
import { AppliedJob } from '../../models/AppliedJob';
import { Job } from '../../models/Job';

/**
 * AI-generated weekly digest for the hirer dashboard. One short
 * paragraph summarising the last 7 days of applicant flow + 2-3
 * "next action" bullets pointed at specific jobs.
 *
 * Routed through Groq (cheap, fast — output is short) and cached 6h
 * per hirer profile so multiple dashboard refreshes don't burn quota.
 *
 * Failures fall back to a deterministic template so the dashboard
 * still has something useful to show when the LLM is down.
 */

export interface DigestSnapshotJob {
  jobId: string;
  title: string;
  totalApplications: number;
  newThisWeek: number;
  shortlisted: number;
  daysSincePosted: number;
}

export interface DigestSnapshot {
  windowDays: number;
  totalJobsActive: number;
  totalApplicationsThisWeek: number;
  totalShortlistedThisWeek: number;
  jobs: DigestSnapshotJob[];
}

export interface HirerDigest {
  headline: string;
  bullets: string[];
  generatedAt: Date;
  cached: boolean;
  usedAi: boolean;
  snapshot: DigestSnapshot;
}

const cacheKey = (hirerProfileId: string, day: string): string =>
  `ai:hirer-digest:${hirerProfileId}:${day}`;

const todayKey = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/**
 * Pull the last-7-day snapshot the digest is generated from. Public so
 * the controller can also include it in the response (UI uses the
 * counts directly without re-querying).
 */
export const buildDigestSnapshot = async (
  hirerProfileId: Types.ObjectId,
): Promise<DigestSnapshot> => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const jobs = await Job.find({
    hirerProfile: hirerProfileId,
    isNative: true,
    status: { $in: ['active', 'paused'] },
  })
    .select('_id title applicationsCount shortlistedCount publishedAt')
    .lean();

  if (jobs.length === 0) {
    return {
      windowDays: 7,
      totalJobsActive: 0,
      totalApplicationsThisWeek: 0,
      totalShortlistedThisWeek: 0,
      jobs: [],
    };
  }

  const jobIds = jobs.map((j) => j._id);

  // Per-job counts of applications received + shortlisted in the last
  // 7 days. One aggregation, two facets.
  const facets = await AppliedJob.aggregate<{
    perJob: { _id: Types.ObjectId; new: number; shortlisted: number }[];
  }>([
    {
      $match: {
        job: { $in: jobIds },
        appliedAt: { $gte: sevenDaysAgo },
      },
    },
    {
      $group: {
        _id: '$job',
        new: { $sum: 1 },
        shortlisted: {
          $sum: {
            $cond: [
              {
                $in: ['$status', ['shortlisted', 'interview', 'offer', 'hired']],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $project: { _id: 1, new: 1, shortlisted: 1 } },
    { $facet: { perJob: [{ $project: { _id: 1, new: 1, shortlisted: 1 } }] } },
  ]);

  const perJob = new Map<
    string,
    { new: number; shortlisted: number }
  >();
  for (const row of facets[0]?.perJob ?? []) {
    perJob.set(row._id.toString(), {
      new: row.new,
      shortlisted: row.shortlisted,
    });
  }

  const now = Date.now();
  const enriched: DigestSnapshotJob[] = jobs
    .map((j) => {
      const id = j._id.toString();
      const stats = perJob.get(id) ?? { new: 0, shortlisted: 0 };
      const daysSincePosted = j.publishedAt
        ? Math.max(
            0,
            Math.floor(
              (now - new Date(j.publishedAt).getTime()) /
                (1000 * 60 * 60 * 24),
            ),
          )
        : 0;
      return {
        jobId: id,
        title: j.title,
        totalApplications: j.applicationsCount ?? 0,
        newThisWeek: stats.new,
        shortlisted: stats.shortlisted,
        daysSincePosted,
      };
    })
    .sort((a, b) => b.newThisWeek - a.newThisWeek);

  return {
    windowDays: 7,
    totalJobsActive: jobs.length,
    totalApplicationsThisWeek: enriched.reduce((s, j) => s + j.newThisWeek, 0),
    totalShortlistedThisWeek: enriched.reduce(
      (s, j) => s + j.shortlisted,
      0,
    ),
    jobs: enriched.slice(0, 8),
  };
};

const SYSTEM_PROMPT = `You write a short weekly digest for a hiring manager looking at their dashboard. Keep it specific, factual, and actionable.

RULES:
- Output STRICT JSON: {"headline": "...", "bullets": ["...", "..."]}.
- "headline": one sentence (max 120 chars), summarising the week's most important fact (e.g. which job pulled the most applicants, or which is stalling).
- "bullets": 2-4 short next-action items, each 8-18 words. Each must reference a SPECIFIC job by title.
- Don't invent counts that aren't in the snapshot.
- If a job has 0 applicants in 7 days AND was posted >5 days ago, suggest reviewing the JD or refreshing it.
- If a job has many applicants but 0 shortlisted, suggest reviewing the new applicants.
- Skip generic platitudes ("hiring is going well", "keep it up").
- Output ONLY the JSON, no markdown fences, no prose.`;

const sanitize = (
  raw: unknown,
): { headline: string; bullets: string[] } | null => {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { headline?: unknown; bullets?: unknown };
  const headline =
    typeof obj.headline === 'string' ? obj.headline.trim().slice(0, 200) : '';
  if (!headline) return null;
  const bullets = Array.isArray(obj.bullets)
    ? obj.bullets
        .map((b) => (typeof b === 'string' ? b.trim() : ''))
        .filter((b) => b.length >= 6 && b.length <= 280)
        .slice(0, 4)
    : [];
  return { headline, bullets };
};

const heuristicDigest = (
  snapshot: DigestSnapshot,
): { headline: string; bullets: string[] } => {
  if (snapshot.totalJobsActive === 0) {
    return {
      headline: 'No active jobs yet — post your first listing to start hiring.',
      bullets: [],
    };
  }
  if (snapshot.totalApplicationsThisWeek === 0) {
    return {
      headline:
        'No new applicants in the last 7 days across your active listings.',
      bullets: snapshot.jobs.slice(0, 3).map(
        (j) =>
          `Review the JD for "${j.title}" — ${j.daysSincePosted}d since posting with no recent traction.`,
      ),
    };
  }
  const top = snapshot.jobs[0];
  const stalling = snapshot.jobs.find(
    (j) => j.newThisWeek === 0 && j.daysSincePosted > 5,
  );
  const headline = top
    ? `"${top.title}" pulled ${top.newThisWeek} new applicant${top.newThisWeek === 1 ? '' : 's'} this week.`
    : `${snapshot.totalApplicationsThisWeek} new applicants across your jobs this week.`;
  const bullets: string[] = [];
  if (top && top.shortlisted === 0 && top.newThisWeek > 0) {
    bullets.push(
      `Review the ${top.newThisWeek} new applicants for "${top.title}" — none shortlisted yet.`,
    );
  }
  if (stalling) {
    bullets.push(
      `Refresh "${stalling.title}" — ${stalling.daysSincePosted}d old with zero new applicants.`,
    );
  }
  if (snapshot.totalShortlistedThisWeek > 0) {
    bullets.push(
      `Move ${snapshot.totalShortlistedThisWeek} shortlisted candidates to interview.`,
    );
  }
  return { headline, bullets };
};

export interface GenerateDigestArgs {
  hirerProfileId: Types.ObjectId;
  /** Hirer user id — passed as `userId` ctx for usage logging. */
  userId: string;
}

export const peekCachedDigest = async (
  hirerProfileId: string,
): Promise<HirerDigest | null> => {
  try {
    const raw = await redis.get(cacheKey(hirerProfileId, todayKey()));
    if (!raw) return null;
    return JSON.parse(raw) as HirerDigest;
  } catch {
    return null;
  }
};

export const generateHirerDigest = async (
  args: GenerateDigestArgs,
): Promise<HirerDigest> => {
  const profileIdStr = args.hirerProfileId.toString();
  const ck = cacheKey(profileIdStr, todayKey());

  // Cache check first — same hirer + same UTC day shouldn't re-spend.
  try {
    const cached = await redis.get(ck);
    if (cached) {
      const parsed = JSON.parse(cached) as HirerDigest;
      return { ...parsed, cached: true };
    }
  } catch (err) {
    logger.warn(`hirerDigest cache read: ${(err as Error).message}`);
  }

  const snapshot = await buildDigestSnapshot(args.hirerProfileId);

  // Fall back to heuristic when AI is off or there's nothing to talk
  // about. Saves a Groq call on accounts with no activity.
  const noProvider =
    !isProviderEnabled('groq') &&
    !isProviderEnabled('gemini') &&
    !isProviderEnabled('claude');
  if (noProvider || snapshot.totalJobsActive === 0) {
    const fallback = heuristicDigest(snapshot);
    const out: HirerDigest = {
      ...fallback,
      generatedAt: new Date(),
      cached: false,
      usedAi: false,
      snapshot,
    };
    return out;
  }

  const preferred: 'groq' | undefined = isProviderEnabled('groq')
    ? 'groq'
    : undefined;

  const userPrompt = [
    `Active jobs: ${snapshot.totalJobsActive}`,
    `New applicants this week: ${snapshot.totalApplicationsThisWeek}`,
    `Shortlisted this week: ${snapshot.totalShortlistedThisWeek}`,
    'Per-job:',
    ...snapshot.jobs.map(
      (j) =>
        `- "${j.title}": ${j.newThisWeek} new, ${j.shortlisted} shortlisted, ${j.totalApplications} total, posted ${j.daysSincePosted}d ago`,
    ),
    'Return the JSON now.',
  ].join('\n');

  try {
    const parsed = await generateJson<unknown>(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEM_PROMPT,
        user: userPrompt,
        json: true,
        maxTokens: 500,
        temperature: 0.4,
      },
      { userId: args.userId, feature: 'hirer_digest' },
    );

    const sane = sanitize(parsed) ?? heuristicDigest(snapshot);
    const out: HirerDigest = {
      headline: sane.headline,
      bullets: sane.bullets,
      generatedAt: new Date(),
      cached: false,
      usedAi: true,
      snapshot,
    };

    try {
      // 24h cache so the digest stays stable across multiple dashboard
      // visits in the same day; the cron / first-of-day visit picks up
      // a fresh one.
      await redis.setex(ck, 60 * 60 * 24, JSON.stringify(out));
    } catch (err) {
      logger.warn(`hirerDigest cache write: ${(err as Error).message}`);
    }

    return out;
  } catch (err) {
    logger.warn(`hirerDigest failed: ${(err as Error).message}`);
    const fallback = heuristicDigest(snapshot);
    return {
      ...fallback,
      generatedAt: new Date(),
      cached: false,
      usedAi: false,
      snapshot,
    };
  }
};
