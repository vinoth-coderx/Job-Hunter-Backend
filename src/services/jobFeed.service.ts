import { redis } from '../config/redis';
import { fetchAllJobsLive } from './scrapers';
import { logger } from '../utils/logger';
import { IJob } from '../models/Job';
import { AppliedJob } from '../models/AppliedJob';
import { IUser } from '../models/User';
import { ScrapedJob, JobType, RemoteType, JobSource } from '../types';
import { HirerProfile } from '../models/HirerProfile';
import mongoose from 'mongoose';

/**
 * Feed orchestration. Owns the merge between native (hirer-posted) jobs
 * from MongoDB and third-party jobs fetched live per request, plus the
 * Redis cache that keeps the third-party fetches from burning quota.
 *
 * Cache is keyed by (query, location) globally — not per-user — so the
 * same role/location combo shared across users hits a single cache entry.
 * Per-user personalisation happens downstream at the matcher.
 */

export const FEED_EXTERNAL_CACHE_TTL_SEC = 30 * 60; // 30 min
const MAX_PROFILE_QUERIES = 3;
const MAX_PROFILE_LOCATIONS = 3;

// ─── FeedJob: unified response shape ────────────────────────────────
export interface FeedJob {
  id: string;
  isNative: boolean;
  source: JobSource;
  externalId?: string;

  /// Set by search/feed endpoints when this job belongs to a "best
  /// match" tier (0-100). Frontend renders the match pill only when
  /// this is present and >= 75 — so a populated screen with 30 jobs
  /// reads as "the first N are matches, rest are related".
  matchScore?: number;

  title: string;
  company: string;
  companyLogoUrl?: string;
  location: string;
  description: string;
  url: string;
  applyUrl?: string;

  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
  jobType?: JobType;
  remoteType?: RemoteType;
  skills?: string[];
  experienceMinYears?: number;
  experienceMaxYears?: number;
  postedAt: Date;

  _id?: string;
  hirerProfile?: string;
  postedBy?: string;
  applyType?: 'easy_apply' | 'custom_form';
  responsibilities?: string[];
  perks?: string[];
  department?: string;

  /// Trust signals derived from the hirer profile, set by the side-load
  /// helper `hydrateTrust`. External (scraped) jobs leave these
  /// undefined; the UI renders `VerifiedBadge` only when the flag is
  /// explicitly true.
  companyVerified?: boolean;
  recruiterTrustScore?: number;
}

export const toFeedJobFromNative = (j: IJob): FeedJob => ({
  id: j._id.toString(),
  _id: j._id.toString(),
  isNative: true,
  source: j.source,
  externalId: j.externalId,
  title: j.title,
  company: j.company,
  companyLogoUrl: j.companyLogoUrl,
  location: j.location,
  description: j.description,
  url: j.url,
  applyUrl: j.applyUrl,
  salaryMin: j.salaryMin,
  salaryMax: j.salaryMax,
  currency: j.currency,
  jobType: j.jobType,
  remoteType: j.remoteType,
  skills: j.skills,
  experienceMinYears: j.experienceMinYears,
  experienceMaxYears: j.experienceMaxYears,
  postedAt: j.postedAt,
  hirerProfile: j.hirerProfile?.toString(),
  postedBy: j.postedBy?.toString(),
  applyType: j.applyType,
  responsibilities: j.responsibilities,
  perks: j.perks,
  department: j.department,
});

/// Side-loads hirer trust signals (companyVerified + recruiterTrustScore)
/// onto a list of native FeedJobs in a single $in query. External jobs
/// are left untouched. Designed to be cheap enough to run on every list
/// response — a single Mongo round-trip per page.
export const hydrateTrust = async (feed: FeedJob[]): Promise<FeedJob[]> => {
  const ids = new Set<string>();
  for (const f of feed) {
    if (f.isNative && f.hirerProfile) ids.add(f.hirerProfile);
  }
  if (ids.size === 0) return feed;
  const profiles = await HirerProfile.find({
    _id: { $in: Array.from(ids).map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .select('verification.isVerified trustScore')
    .lean();
  const byId = new Map<string, { verified: boolean; trustScore: number }>();
  for (const p of profiles) {
    byId.set(p._id.toString(), {
      verified: p.verification?.isVerified === true,
      trustScore: typeof p.trustScore === 'number' ? p.trustScore : 50,
    });
  }
  for (const f of feed) {
    if (!f.isNative || !f.hirerProfile) continue;
    const t = byId.get(f.hirerProfile);
    if (!t) continue;
    f.companyVerified = t.verified;
    f.recruiterTrustScore = t.trustScore;
  }
  return feed;
};

export const toFeedJobFromScraped = (s: ScrapedJob): FeedJob => ({
  id: `${s.source}:${s.externalId}`,
  isNative: false,
  source: s.source,
  externalId: s.externalId,
  title: s.title,
  company: s.company,
  companyLogoUrl: s.companyLogoUrl,
  location: s.location,
  description: s.description,
  url: s.url,
  // Prefer the curated applyUrl (LinkedIn / direct / official) picked at
  // scrape-time. Falls back to `url` so the frontend always has *some*
  // target — older cached entries without applyUrl still work.
  applyUrl: s.applyUrl || s.url,
  salaryMin: s.salaryMin,
  salaryMax: s.salaryMax,
  currency: s.currency,
  jobType: s.jobType,
  remoteType: s.remoteType,
  skills: s.skills,
  postedAt: s.postedAt,
});

// ─── Profile-driven query derivation ────────────────────────────────
export const deriveProfileQueries = (
  user: IUser | null,
  fallback?: string,
): string[] => {
  const queries: string[] = [];
  if (user) {
    queries.push(
      ...(user.profile.preferredRoles || []).slice(0, MAX_PROFILE_QUERIES),
    );
    if (queries.length < MAX_PROFILE_QUERIES) {
      queries.push(
        ...(user.profile.skills || []).slice(
          0,
          MAX_PROFILE_QUERIES - queries.length,
        ),
      );
    }
  }
  if (queries.length === 0 && fallback) queries.push(fallback);
  return queries
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .slice(0, MAX_PROFILE_QUERIES);
};

export const deriveProfileLocations = (
  user: IUser | null,
  fallback?: string,
): string[] => {
  const locs: string[] = [];
  if (user) {
    locs.push(
      ...(user.profile.preferredLocations || []).slice(0, MAX_PROFILE_LOCATIONS),
    );
  }
  if (locs.length === 0 && fallback) locs.push(fallback);
  return locs
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_PROFILE_LOCATIONS);
};

// ─── Live-fetch with Redis cache ────────────────────────────────────
const normaliseForKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const cacheKeyForExternal = (query: string, location: string): string =>
  `feed:ext:${normaliseForKey(query)}:${normaliseForKey(location) || 'any'}`;

const fetchExternalCached = async (
  query: string,
  location: string,
): Promise<ScrapedJob[]> => {
  const key = cacheKeyForExternal(query, location);

  try {
    const hit = await redis.get(key);
    if (hit) {
      const parsed = JSON.parse(hit) as ScrapedJob[];
      // JSON loses Date — revive postedAt so downstream sorts/comparisons work.
      return parsed.map((j) => ({ ...j, postedAt: new Date(j.postedAt) }));
    }
  } catch (e) {
    logger.warn('jobFeed cache read failed', { key, err: (e as Error).message });
  }

  const live = await fetchAllJobsLive({
    queries: [query],
    locations: location ? [location] : undefined,
  });

  try {
    await redis.setex(key, FEED_EXTERNAL_CACHE_TTL_SEC, JSON.stringify(live));
  } catch (e) {
    logger.warn('jobFeed cache write failed', { key, err: (e as Error).message });
  }
  return live;
};

/**
 * Run the (queries × locations) matrix through the cache and dedupe by
 * `source:externalId`. Caller is expected to keep both lists small —
 * this service caps at 3 × 3 = 9 cache lookups per request.
 */
export const fetchExternalForProfile = async (
  queries: string[],
  locations: string[],
): Promise<ScrapedJob[]> => {
  if (queries.length === 0) return [];
  const effectiveLocations = locations.length ? locations : [''];

  const seen = new Set<string>();
  const out: ScrapedJob[] = [];

  for (const q of queries) {
    for (const loc of effectiveLocations) {
      const jobs = await fetchExternalCached(q, loc);
      for (const j of jobs) {
        const k = `${j.source}:${j.externalId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(j);
      }
    }
  }
  return out;
};

// ─── Applied-job exclusion ──────────────────────────────────────────
export interface AppliedExclusion {
  /** Native job ObjectId hex strings the user has already applied to. */
  jobIds: Set<string>;
  /** `${source}:${externalId}` keys for external jobs the user applied to. */
  externalKeys: Set<string>;
}

export const buildAppliedExclusion = async (
  userId: string | undefined,
): Promise<AppliedExclusion> => {
  const exclusion: AppliedExclusion = {
    jobIds: new Set<string>(),
    externalKeys: new Set<string>(),
  };
  if (!userId) return exclusion;

  const apps = await AppliedJob.find({ user: userId })
    .select('job jobSnapshot.source jobSnapshot.externalId')
    .lean();

  for (const a of apps) {
    if (a.job) exclusion.jobIds.add(a.job.toString());
    const src = a.jobSnapshot?.source;
    const ext = a.jobSnapshot?.externalId;
    if (src && ext) exclusion.externalKeys.add(`${src}:${ext}`);
  }
  return exclusion;
};

export const filterApplied = (
  jobs: FeedJob[],
  applied: AppliedExclusion,
): FeedJob[] =>
  jobs.filter((j) => {
    if (j.isNative) return !applied.jobIds.has(j.id);
    if (j.externalId) {
      return !applied.externalKeys.has(`${j.source}:${j.externalId}`);
    }
    return true;
  });

// ─── Single-job lookup (for /jobs/:id) ──────────────────────────────
/**
 * For external jobs, the only cached source of truth is the per-query
 * Redis cache. Scan the recently cached entries by source and external id
 * — best-effort; expired cache returns null so the client falls back to
 * the URL it already has from the search response.
 */
export const lookupExternalJobFromCache = async (
  source: JobSource,
  externalId: string,
): Promise<ScrapedJob | null> => {
  try {
    // SCAN is O(N) over keys; the keyspace stays small because every
    // entry is namespaced under `feed:ext:` and expires in 30 min.
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        'feed:ext:*',
        'COUNT',
        200,
      );
      cursor = next;
      if (keys.length === 0) continue;
      const values = await redis.mget(...keys);
      for (const v of values) {
        if (!v) continue;
        try {
          const list = JSON.parse(v) as ScrapedJob[];
          const hit = list.find(
            (j) => j.source === source && j.externalId === externalId,
          );
          if (hit) return { ...hit, postedAt: new Date(hit.postedAt) };
        } catch {
          // skip malformed cache entry
        }
      }
    } while (cursor !== '0');
  } catch (e) {
    logger.warn('lookupExternalJobFromCache failed', {
      source,
      externalId,
      err: (e as Error).message,
    });
  }
  return null;
};
