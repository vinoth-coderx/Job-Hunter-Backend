import { AdzunaScraper } from './adzuna.service';
import { SerpApiScraper } from './serpapi.service';
import { RapidApiScraper } from './rapidapi.service';
import { PuppeteerScraper } from './puppeteer.service';
import { Job } from '../../models/Job';
import { ScrapedJob } from '../../types';
import { logger } from '../../utils/logger';
import { redis, CACHE_KEYS } from '../../config/redis';
import { env } from '../../config/env';

const adzuna = new AdzunaScraper();
const serp = new SerpApiScraper();
const rapid = new RapidApiScraper();
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

  for (const s of [adzuna, serp, rapid, puppeteerScraper]) s.resetForNewRun();

  const all: ScrapedJob[] = [];
  const bySource: Record<string, number> = {
    adzuna: 0,
    serpapi: 0,
    rapidapi: 0,
    puppeteer: 0,
  };

  for (const query of queries) {
    for (const location of locations) {
      const tasks = [
        adzuna.fetch(query, location),
        serp.fetch(query, location),
        rapid.fetch(query, location),
      ];
      if (usePuppeteer) tasks.push(puppeteerScraper.fetch(query, location));

      const results = await Promise.allSettled(tasks);

      for (const r of results) {
        if (r.status === 'fulfilled') {
          for (const j of r.value) {
            all.push(j);
            bySource[j.source] = (bySource[j.source] || 0) + 1;
          }
        }
      }
    }
  }

  if (usePuppeteer) {
    await puppeteerScraper.close();
  }

  let inserted = 0;
  let updated = 0;

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
      if (result.upsertedCount > 0) inserted++;
      else if (result.modifiedCount > 0) updated++;
    } catch (err) {
      logger.warn('Failed to upsert job', { id: j.externalId, source: j.source, err });
    }
  }

  const cutoff = new Date(Date.now() - env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
  await Job.updateMany({ postedAt: { $lt: cutoff } }, { $set: { isActive: false } });

  await redis.del(CACHE_KEYS.ALL_JOBS);
  const keys = await redis.keys('jobs:*');
  if (keys.length) await redis.del(...keys);

  logger.info(
    `Job fetch complete — total: ${all.length}, inserted: ${inserted}, updated: ${updated}`,
    bySource,
  );

  return { total: all.length, inserted, updated, bySource };
};

export { adzuna, serp, rapid, puppeteerScraper };
