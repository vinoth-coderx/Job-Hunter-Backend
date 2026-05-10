import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { IUser } from '../../models/User';
import { Job, IJob } from '../../models/Job';
import { JobView } from '../../models/JobView';
import { SavedJob } from '../../models/SavedJob';
import { AppliedJob } from '../../models/AppliedJob';
import { JOB_FRESHNESS_DAYS } from '../../config/constants';
import { generateJson } from './providers';

/**
 * Anticipatory recommendation engine.
 *
 * Each time the home screen opens, we read the user's recent activity
 * (last 10 views, last 10 saves, last 10 applies) and turn it into a
 * "what they're really looking for" intent signature. Combined with the
 * profile, this is sent to Gemini ONCE per 30 minutes (cached) to return
 * 3 hand-picked jobs + a one-line insight ("you've been looking at remote
 * Flutter roles in Bangalore — here's the closest match").
 *
 * Quota cost: 1 slot per cache miss. Cache TTL 30 min ⇒ even active users
 * spend at most ~6 slots/day on this surface.
 */

export interface ForYouRecommendation {
  jobId: string;
  title: string;
  company: string;
  whyThisJob: string; // 1-line reason tied to user's recent activity
  matchSignals: string[]; // e.g., ["matches your Flutter focus", "Bangalore"]
}

export interface ForYouResult {
  insight: string; // "We noticed you're focused on remote Flutter work."
  picks: ForYouRecommendation[];
  cachedAt: string;
  expiresAt: string;
}

const CACHE_TTL_SEC = 30 * 60;
const CACHE_KEY = (uid: string) => `ai:foryou:${uid}`;

const getRecentSignals = async (
  userId: string,
): Promise<{
  viewedJobs: IJob[];
  savedTitles: string[];
  appliedTitles: string[];
}> => {
  const [viewDocs, savedDocs, appliedDocs] = await Promise.all([
    JobView.find({ user: userId })
      .sort({ viewedAt: -1 })
      .limit(10)
      .populate<{ job: IJob }>('job', 'title company location remoteType skills jobType')
      .lean(),
    SavedJob.find({ user: userId })
      .sort({ savedAt: -1 })
      .limit(10)
      .populate<{ job: IJob }>('job', 'title company')
      .lean(),
    AppliedJob.find({ user: userId })
      .sort({ appliedAt: -1 })
      .limit(10)
      .populate<{ job: IJob }>('job', 'title company')
      .lean(),
  ]);

  return {
    viewedJobs: viewDocs.map((v) => v.job).filter(Boolean) as IJob[],
    savedTitles: savedDocs.map((s) => (s.job ? `${s.job.title} @ ${s.job.company}` : '')).filter(Boolean),
    appliedTitles: appliedDocs.map((a) => (a.job ? `${a.job.title} @ ${a.job.company}` : '')).filter(Boolean),
  };
};

const compactJobLine = (j: IJob): string =>
  `id:${j._id.toString()} | ${j.title} @ ${j.company} | ${j.location} (${j.remoteType}) | ${j.jobType} | skills: ${(j.skills || []).slice(0, 8).join(', ')}`;

const SYSTEM_PROMPT = `You are an anticipatory career assistant. From a candidate's profile + their recent app activity (jobs viewed, saved, applied), you spot what they're REALLY hunting for and pick the 3 best fresh jobs from the available pool. Output STRICT JSON, no prose.

Schema:
{
  "insight": "<one sentence: what we noticed about their search pattern>",
  "picks": [
    {
      "jobId": "<exact id from input pool>",
      "title": "<job title>",
      "company": "<company>",
      "whyThisJob": "<one sentence tying this pick to their recent activity>",
      "matchSignals": ["short reason 1", "short reason 2"]
    }
  ]
}

Rules:
- picks MUST be exactly 3 items.
- jobId MUST be from the input pool — never invent.
- whyThisJob ties to recent activity ("you saved 3 Flutter roles", "you applied to similar remote backend jobs").
- If recent activity is empty, base picks on profile preferences and say so in insight.
- Skip the recommendation entirely (return empty picks) if no fresh jobs at all.`;

export const getForYouRecommendations = async (
  user: IUser,
  opts: { forceRefresh?: boolean } = {},
): Promise<ForYouResult | null> => {
  const userId = String(user._id);
  const cacheKey = CACHE_KEY(userId);

  if (!opts.forceRefresh) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as ForYouResult;
      } catch {
        // fall through to recompute
      }
    }
  }

  const signals = await getRecentSignals(userId);

  const sinceMs = Date.now() - JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
  const pool = await Job.find({
    status: 'active',
    postedAt: { $gte: new Date(sinceMs) },
  })
    .sort({ postedAt: -1 })
    .limit(40)
    .lean();

  if (pool.length === 0) {
    logger.info('getForYouRecommendations: empty job pool, returning null');
    return null;
  }

  const profileBlock = [
    `Name: ${user.profile.fullName || 'Unknown'}`,
    `Headline: ${user.profile.headline || 'N/A'}`,
    `Skills: ${(user.profile.skills || []).slice(0, 30).join(', ') || 'N/A'}`,
    `Preferred Roles: ${(user.profile.preferredRoles || []).join(', ') || 'N/A'}`,
    `Preferred Locations: ${(user.profile.preferredLocations || []).join(', ') || 'N/A'}`,
    `Experience: ${user.profile.experienceYears ?? 0} years`,
  ].join('\n');

  const recentBlock = [
    `Recently viewed (${signals.viewedJobs.length}):`,
    signals.viewedJobs.map((j) => `- ${j.title} @ ${j.company} (${j.location})`).join('\n') || '  (none)',
    `Saved: ${signals.savedTitles.join('; ') || '(none)'}`,
    `Applied: ${signals.appliedTitles.join('; ') || '(none)'}`,
  ].join('\n');

  const poolBlock = pool.map((j) => compactJobLine(j as unknown as IJob)).join('\n');

  const userPrompt = `CANDIDATE PROFILE:
${profileBlock}

RECENT ACTIVITY:
${recentBlock}

AVAILABLE JOB POOL (${pool.length}):
${poolBlock}

Return the JSON now.`;

  const result = await generateJson<{ insight: string; picks: ForYouRecommendation[] }>({
    tier: 'smart',
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 1500,
    temperature: 0.4,
  });

  if (!result) return null;

  const validIds = new Set(pool.map((j) => j._id.toString()));
  const picksIn = Array.isArray(result.picks) ? result.picks : [];
  const picks = picksIn
    .filter((p): p is ForYouRecommendation => !!p && typeof p === 'object')
    .filter((p) => validIds.has(p.jobId))
    .map((p) => ({
      jobId: p.jobId,
      title: String(p.title || '').slice(0, 200),
      company: String(p.company || '').slice(0, 200),
      whyThisJob: String(p.whyThisJob || '').slice(0, 300),
      matchSignals: Array.isArray(p.matchSignals)
        ? p.matchSignals.map((s) => String(s).slice(0, 80)).filter(Boolean).slice(0, 4)
        : [],
    }))
    .slice(0, 3);

  const now = new Date();
  const out: ForYouResult = {
    insight: String(result.insight || '').slice(0, 400),
    picks,
    cachedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CACHE_TTL_SEC * 1000).toISOString(),
  };

  try {
    await redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(out));
  } catch (err) {
    logger.warn(`for-you cache persist failed: ${(err as Error).message}`);
  }

  return out;
};

/**
 * Whether the user has a usable cached result. Used by the controller to
 * skip quota enforcement on cache hits — those don't make AI calls.
 */
export const hasForYouCached = async (userId: string): Promise<boolean> => {
  const exists = await redis.exists(CACHE_KEY(userId));
  return exists === 1;
};
