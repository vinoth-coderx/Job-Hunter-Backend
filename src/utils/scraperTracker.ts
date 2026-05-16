import { redis } from '../config/redis';
import { logger } from './logger';

/**
 * Per-source observability for the scraper pipeline. Mirrors the spirit
 * of [cronTracker] but tracks aggregate stats per-source per-run instead
 * of a single status hash. Each `fetchAllJobs()` call ends with one
 * [recordScraperRun] per source; the admin Job Sources page reads back
 * the rolling window via [readScraperStats].
 *
 * Storage shape (Redis):
 *   scraper:run:<source>            HASH  → latest snapshot
 *   scraper:history:<source>        LIST  → rolling LPUSH+LTRIM 100 runs
 *
 * Why a list, not a sorted set: we never need range queries by score;
 * the dashboard only ever reads "the last N runs to compute 24h totals"
 * which is exactly an LRANGE 0 N.
 */

const HISTORY_CAP = 100;

const latestKey = (source: string): string => `scraper:run:${source}`;
const historyKey = (source: string): string => `scraper:history:${source}`;

export interface ScraperRunStats {
  total: number;
  inserted: number;
  updated: number;
  errors: number;
  durationMs: number;
  /// Coarse-grained reason describing the run's outcome — surfaced to
  /// the admin dashboard so an all-zero row is debuggable. See
  /// `ScraperRunStatus` in services/scrapers/base.ts for the vocabulary.
  status?: string;
  /// Short human-readable detail accompanying [status] (e.g. the missing
  /// AppConfig key name, the HTTP status code text).
  statusDetail?: string;
}

export interface ScraperRunRecord extends ScraperRunStats {
  ts: string;
}

export const recordScraperRun = async (
  source: string,
  stats: ScraperRunStats,
): Promise<void> => {
  const record: ScraperRunRecord = {
    ...stats,
    ts: new Date().toISOString(),
  };
  try {
    const hashPayload: Record<string, string> = {
      lastRunAt: record.ts,
      lastJobsFetched: stats.total.toString(),
      lastInserted: stats.inserted.toString(),
      lastUpdated: stats.updated.toString(),
      lastErrors: stats.errors.toString(),
      lastDurationMs: stats.durationMs.toString(),
    };
    if (stats.status) hashPayload.lastStatus = stats.status;
    if (stats.statusDetail) hashPayload.lastStatusDetail = stats.statusDetail;
    await redis.hset(latestKey(source), hashPayload);
    if (!stats.status) {
      // Explicit delete so a run that didn't report a status doesn't
      // keep showing the last one — stale notes are worse than none.
      await redis.hdel(latestKey(source), 'lastStatus', 'lastStatusDetail');
    } else if (!stats.statusDetail) {
      await redis.hdel(latestKey(source), 'lastStatusDetail');
    }
    await redis.hincrby(latestKey(source), 'runCount', 1);
    if (stats.errors > 0) {
      await redis.hincrby(latestKey(source), 'totalErrors', stats.errors);
    }
    await redis.lpush(historyKey(source), JSON.stringify(record));
    await redis.ltrim(historyKey(source), 0, HISTORY_CAP - 1);
  } catch (err) {
    // Tracker writes never crash the scraper pipeline.
    logger.warn(`scraperTracker write failed for ${source}: ${err}`);
  }
};

export interface ScraperStatsSnapshot {
  source: string;
  lastRunAt: string | null;
  lastJobsFetched: number;
  lastInserted: number;
  lastUpdated: number;
  lastErrors: number;
  lastDurationMs: number;
  lastStatus: string | null;
  lastStatusDetail: string | null;
  runCount: number;
  totalErrors: number;
  /** Aggregates over runs in the trailing window (default 24h). */
  window: {
    runs: number;
    totalJobs: number;
    newJobs: number;
    duplicates: number;
    errors: number;
    avgDurationMs: number;
  };
}

export const readScraperStats = async (
  source: string,
  windowMs: number = 24 * 60 * 60 * 1000,
): Promise<ScraperStatsSnapshot> => {
  let raw: Record<string, string> = {};
  let history: string[] = [];
  try {
    raw = await redis.hgetall(latestKey(source));
    history = await redis.lrange(historyKey(source), 0, HISTORY_CAP - 1);
  } catch (err) {
    logger.warn(`scraperTracker read failed for ${source}: ${err}`);
  }

  const cutoff = Date.now() - windowMs;
  let runs = 0;
  let totalJobs = 0;
  let newJobs = 0;
  let duplicates = 0;
  let errors = 0;
  let durationSum = 0;
  for (const blob of history) {
    try {
      const r = JSON.parse(blob) as ScraperRunRecord;
      if (new Date(r.ts).getTime() < cutoff) continue;
      runs += 1;
      totalJobs += r.total;
      newJobs += r.inserted;
      // Duplicates ≈ rows that came back but didn't insert (already had
      // them, or the upsert touched no fields). Includes "updated" since
      // those weren't first-time inserts from the dashboard's POV.
      duplicates += r.total - r.inserted;
      errors += r.errors;
      durationSum += r.durationMs;
    } catch {
      // Ignore corrupt history entries.
    }
  }

  return {
    source,
    lastRunAt: raw.lastRunAt || null,
    lastJobsFetched: parseInt(raw.lastJobsFetched ?? '0', 10) || 0,
    lastInserted: parseInt(raw.lastInserted ?? '0', 10) || 0,
    lastUpdated: parseInt(raw.lastUpdated ?? '0', 10) || 0,
    lastErrors: parseInt(raw.lastErrors ?? '0', 10) || 0,
    lastDurationMs: parseInt(raw.lastDurationMs ?? '0', 10) || 0,
    lastStatus: raw.lastStatus || null,
    lastStatusDetail: raw.lastStatusDetail || null,
    runCount: parseInt(raw.runCount ?? '0', 10) || 0,
    totalErrors: parseInt(raw.totalErrors ?? '0', 10) || 0,
    window: {
      runs,
      totalJobs,
      newJobs,
      duplicates,
      errors,
      avgDurationMs: runs > 0 ? Math.round(durationSum / runs) : 0,
    },
  };
};

/**
 * Static catalog of the scrapers the backend orchestrates. The admin UI
 * uses this to render a card per source even when no run has been
 * recorded yet (`lastRunAt = null` shows as "Never run"). Add an entry
 * here when a new scraper class is wired into [fetchAllJobs].
 */
export interface ScraperDefinition {
  source: string;
  label: string;
  category: string;
  /** Plain text shown under the title. */
  pricing: 'Free' | 'Freemium' | 'Paid';
  /** Config keys this source needs (read from AppConfig). Empty = no key. */
  keyConfigKeys: string[];
  /** True if this scraper works without any API key. */
  isKeyless: boolean;
  /** Used to flag the Puppeteer headless-browser scraper specifically. */
  notes?: string;
}

export const KNOWN_SCRAPERS: ScraperDefinition[] = [
  {
    source: 'adzuna',
    label: 'Adzuna',
    category: 'Job Board API',
    pricing: 'Freemium',
    keyConfigKeys: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
    isKeyless: false,
  },
  {
    source: 'serpapi',
    label: 'SerpApi',
    category: 'Google Jobs',
    pricing: 'Paid',
    keyConfigKeys: ['SERPAPI_KEY'],
    isKeyless: false,
  },
  {
    source: 'rapidapi',
    label: 'JSearch (OpenWebNinja)',
    category: 'Job Board API',
    pricing: 'Freemium',
    keyConfigKeys: ['OPENWEBNINJA_API_KEY'],
    isKeyless: false,
    notes: 'Hosted on api.openwebninja.com/jsearch/search-v2 (auth: X-API-Key).',
  },
  {
    source: 'realtime_web_search',
    label: 'Real-Time Web Search',
    category: 'Web Search',
    pricing: 'Freemium',
    keyConfigKeys: ['OPENWEBNINJA_API_KEY'],
    isKeyless: false,
    notes: 'OpenWebNinja Real-Time Web Search — surfaces direct careers pages and niche boards JSearch misses.',
  },
  {
    source: 'arbeitnow',
    label: 'Arbeitnow',
    category: 'EU Jobs',
    pricing: 'Free',
    keyConfigKeys: [],
    isKeyless: true,
    notes: 'No key required — always on',
  },
  {
    source: 'puppeteer',
    label: 'Puppeteer',
    category: 'Web Scraper',
    pricing: 'Free',
    keyConfigKeys: [],
    isKeyless: true,
    notes: 'No key required — headless browser',
  },
];
