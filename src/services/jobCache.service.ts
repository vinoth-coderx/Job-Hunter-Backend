import { Job } from '../models/Job';
import { redis, CACHE_KEYS } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const buildAllJobsPayload = async (): Promise<{
  success: true;
  data: unknown[];
  meta: { total: number; freshnessDays: number; warmedAt: string };
}> => {
  const cutoff = new Date(Date.now() - env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
  const items = await Job.find(
    { isActive: true, postedAt: { $gte: cutoff } },
    { raw: 0 },
  )
    .sort({ postedAt: -1 })
    .lean();

  return {
    success: true,
    data: items,
    meta: {
      total: items.length,
      freshnessDays: env.JOB_FRESHNESS_DAYS,
      warmedAt: new Date().toISOString(),
    },
  };
};

export const warmJobsCache = async (): Promise<{ total: number; cachedKey: string; ttl: number }> => {
  const payload = await buildAllJobsPayload();
  await redis.setex(CACHE_KEYS.ALL_JOBS, env.REDIS_JOB_CACHE_TTL, JSON.stringify(payload));
  logger.info(`Warmed ${CACHE_KEYS.ALL_JOBS} cache — ${payload.meta.total} jobs, TTL ${env.REDIS_JOB_CACHE_TTL}s`);
  return { total: payload.meta.total, cachedKey: CACHE_KEYS.ALL_JOBS, ttl: env.REDIS_JOB_CACHE_TTL };
};

export const clearJobsCache = async (): Promise<{ deletedKeys: number }> => {
  const keys = await redis.keys('jobs:*');
  if (!keys.length) return { deletedKeys: 0 };
  const deleted = await redis.del(...keys);
  logger.info(`Cleared ${deleted} jobs:* cache keys`);
  return { deletedKeys: deleted };
};
