import { AdzunaScraper } from './adzuna.service';
import { SerpApiScraper } from './serpapi.service';
import { RapidApiScraper } from './rapidapi.service';
import { ArbeitnowScraper } from './arbeitnow.service';
import { TheirStackScraper } from './theirstack.service';
import { PuppeteerScraper } from './puppeteer.service';
import { GenericApiScraper } from './generic.service';
import { Job } from '../../models/Job';
import { ScrapedJob } from '../../types';
import { logger } from '../../utils/logger';
import { JOB_FRESHNESS_DAYS } from '../../config/constants';
import { recordScraperRun } from '../../utils/scraperTracker';
import { getJobSourceConfigs } from '../jobSourceConfig.service';
import { IJobSourceConfig } from '../../models/JobSourceConfig';

const adzuna = new AdzunaScraper();
const serp = new SerpApiScraper();
const rapid = new RapidApiScraper();
const arbeitnow = new ArbeitnowScraper();
const theirstack = new TheirStackScraper();
const puppeteerScraper = new PuppeteerScraper();

const DEFAULT_QUERIES = [
  'software engineer',
  'frontend developer',
  'backend developer',
  'full stack developer',
  'flutter developer',
  'react developer',
  'node.js developer',
  'data engineer',
  'devops engineer',
];

const DEFAULT_LOCATIONS = ['India', 'Bangalore', 'Chennai', 'Hyderabad', 'Pune', 'Remote'];

export interface FetchOptions {
  queries?: string[];
  locations?: string[];
  usePuppeteer?: boolean;
}

export const fetchAllJobs = async (opts: FetchOptions = {}): Promise<{
  total: number;
  inserted: number;
  updated: number;
  bySource: Record<string, number>;
}> => {
  const queries = opts.queries?.length ? opts.queries : DEFAULT_QUERIES;
  const locations = opts.locations?.length ? opts.locations : DEFAULT_LOCATIONS;
  const usePuppeteer = opts.usePuppeteer ?? false;

  logger.info(`Starting job fetch: ${queries.length} queries x ${locations.length} locations`);

  // Admin-managed enablement: each source must have an enabled row in
  // JobSourceConfig. A missing row is treated as enabled (graceful
  // fallback if the seed hasn't run yet, e.g. during tests).
  const sourceCfgs = await getJobSourceConfigs().catch(() => [] as IJobSourceConfig[]);
  const disabled = new Set(
    sourceCfgs.filter((c) => !c.enabled).map((c) => c.source),
  );
  const isOn = (source: string): boolean => !disabled.has(source);

  // Build a fresh GenericApiScraper per enabled generic source. These
  // aren't long-lived singletons because the admin can change config
  // (endpoint, headers, mapping) between runs.
  const genericScrapers: GenericApiScraper[] = sourceCfgs
    .filter((c) => c.type === 'generic' && c.enabled && c.generic)
    .map((c) => new GenericApiScraper(c));

  for (const s of [adzuna, serp, rapid, arbeitnow, theirstack, puppeteerScraper, ...genericScrapers]) {
    s.resetForNewRun();
  }

  const all: ScrapedJob[] = [];
  const bySource: Record<string, number> = {
    adzuna: 0,
    serpapi: 0,
    rapidapi: 0,
    arbeitnow: 0,
    theirstack: 0,
    puppeteer: 0,
  };
  // Seed bySource counters for generic sources so the tracker rollup
  // includes them even when zero jobs come back.
  for (const g of genericScrapers) {
    bySource[g.source] = 0;
  }
  // Per-source instrumentation for the admin Job Sources dashboard.
  // Duration is the sum of every fetch() call's wall time for that
  // source across the query×location matrix; errors counts how many of
  // those calls rejected (Promise.allSettled buckets them as 'rejected').
  const sourceDurationMs: Record<string, number> = {};
  const sourceErrors: Record<string, number> = {};

  // Stable index → source map so we can label settled results without
  // repeating the source name in every push below.
  const buildTasks = (
    query: string,
    location: string,
  ): Array<{ source: string; promise: Promise<ScrapedJob[]>; started: number }> => {
    const taskList: Array<{ source: string; promise: Promise<ScrapedJob[]>; started: number }> = [];
    const time = (source: string, p: Promise<ScrapedJob[]>) => {
      const started = Date.now();
      taskList.push({ source, promise: p, started });
    };
    if (isOn('adzuna')) time('adzuna', adzuna.fetch(query, location));
    if (isOn('serpapi')) time('serpapi', serp.fetch(query, location));
    if (isOn('rapidapi')) time('rapidapi', rapid.fetch(query, location));
    if (isOn('arbeitnow')) time('arbeitnow', arbeitnow.fetch(query, location));
    if (isOn('theirstack')) time('theirstack', theirstack.fetch(query, location));
    if (usePuppeteer && isOn('puppeteer'))
      time('puppeteer', puppeteerScraper.fetch(query, location));
    for (const g of genericScrapers) {
      time(g.source, g.fetch(query, location));
    }
    return taskList;
  };

  for (const query of queries) {
    for (const location of locations) {
      const tasks = buildTasks(query, location);
      const results = await Promise.allSettled(tasks.map((t) => t.promise));

      for (let i = 0; i < results.length; i++) {
        const t = tasks[i];
        const r = results[i];
        sourceDurationMs[t.source] =
          (sourceDurationMs[t.source] || 0) + (Date.now() - t.started);
        if (r.status === 'fulfilled') {
          for (const j of r.value) {
            all.push(j);
            bySource[j.source] = (bySource[j.source] || 0) + 1;
          }
        } else {
          sourceErrors[t.source] = (sourceErrors[t.source] || 0) + 1;
        }
      }
    }
  }

  if (usePuppeteer) {
    await puppeteerScraper.close();
  }

  let inserted = 0;
  let updated = 0;
  const insertedBySource: Record<string, number> = {};
  const updatedBySource: Record<string, number> = {};

  for (const j of all) {
    try {
      const result = await Job.updateOne(
        { externalId: j.externalId, source: j.source },
        {
          $set: {
            title: j.title,
            company: j.company,
            location: j.location,
            description: j.description,
            url: j.url,
            salaryMin: j.salaryMin,
            salaryMax: j.salaryMax,
            currency: j.currency,
            jobType: j.jobType ?? 'unknown',
            remoteType: j.remoteType ?? 'unknown',
            skills: j.skills ?? [],
            postedAt: j.postedAt,
            fetchedAt: new Date(),
            isActive: true,
            raw: j.raw,
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0) {
        inserted++;
        insertedBySource[j.source] = (insertedBySource[j.source] || 0) + 1;
      } else if (result.modifiedCount > 0) {
        updated++;
        updatedBySource[j.source] = (updatedBySource[j.source] || 0) + 1;
      }
    } catch (err) {
      logger.warn('Failed to upsert job', { id: j.externalId, source: j.source, err });
    }
  }

  const cutoff = new Date(Date.now() - JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
  await Job.updateMany({ postedAt: { $lt: cutoff } }, { $set: { isActive: false } });

  logger.info(
    `Job fetch complete — total: ${all.length}, inserted: ${inserted}, updated: ${updated}`,
    bySource,
  );

  // Persist per-source rollup so the admin dashboard can render
  // last-run / 24h aggregates. Best-effort: tracker errors are swallowed
  // inside [recordScraperRun] so they can't bubble up and fail the run.
  const sources = Object.keys(bySource);
  await Promise.all(
    sources.map((source) =>
      recordScraperRun(source, {
        total: bySource[source] || 0,
        inserted: insertedBySource[source] || 0,
        updated: updatedBySource[source] || 0,
        errors: sourceErrors[source] || 0,
        durationMs: sourceDurationMs[source] || 0,
      }),
    ),
  );

  return { total: all.length, inserted, updated, bySource };
};

export interface LiveFetchOptions {
  queries: string[];
  locations?: string[];
  /** Include bulk-only sources (arbeitnow, theirstack). Off by default — these
   *  ignore query/location filters and self-throttle, so they're cron-only. */
  includeBulkSources?: boolean;
}

/**
 * Live (in-memory) fetch from query-specific scrapers. No DB writes, no
 * freshness sweep — intended for request-time, profile-driven search.
 * Deduplicates by `${source}:${externalId}`.
 */
export const fetchAllJobsLive = async (
  opts: LiveFetchOptions,
): Promise<ScrapedJob[]> => {
  const queries = opts.queries.filter((q) => q.trim().length > 0);
  if (queries.length === 0) return [];
  const locations = opts.locations?.length ? opts.locations : [''];
  const includeBulk = opts.includeBulkSources ?? false;

  const seen = new Set<string>();
  const out: ScrapedJob[] = [];

  const sourceCfgs = await getJobSourceConfigs().catch(() => [] as IJobSourceConfig[]);
  const disabled = new Set(
    sourceCfgs.filter((c) => !c.enabled).map((c) => c.source),
  );
  const isOn = (source: string): boolean => !disabled.has(source);
  const genericScrapers: GenericApiScraper[] = sourceCfgs
    .filter((c) => c.type === 'generic' && c.enabled && c.generic)
    .map((c) => new GenericApiScraper(c));

  for (const query of queries) {
    for (const location of locations) {
      const tasks: Promise<ScrapedJob[]>[] = [];
      if (isOn('adzuna')) tasks.push(adzuna.fetch(query, location));
      if (isOn('serpapi')) tasks.push(serp.fetch(query, location));
      if (isOn('rapidapi')) tasks.push(rapid.fetch(query, location));
      if (includeBulk) {
        if (isOn('arbeitnow')) tasks.push(arbeitnow.fetch(query, location));
        if (isOn('theirstack')) tasks.push(theirstack.fetch(query, location));
      }
      for (const g of genericScrapers) {
        tasks.push(g.fetch(query, location));
      }

      const results = await Promise.allSettled(tasks);
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        for (const j of r.value) {
          const key = `${j.source}:${j.externalId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(j);
        }
      }
    }
  }

  return out;
};

export { adzuna, serp, rapid, arbeitnow, theirstack, puppeteerScraper };
