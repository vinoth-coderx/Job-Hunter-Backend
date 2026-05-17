import Redis, { RedisOptions } from 'ioredis';
import { env } from './env';
import { REDIS_DB } from './constants';
import { readRuntimeMode } from './runtimeMode';
import { logger } from '../utils/logger';

const useTls = env.REDIS_TLS === 'true';

/**
 * Build ioredis options for the active runtime mode. URL form is
 * preferred when set (`REDIS_URL_TEST` / `REDIS_URL_LIVE`) — ioredis
 * accepts these directly. Otherwise we fall back to the discrete
 * REDIS_* quintet (single Redis instance shared by both modes).
 */
const buildRedisOptions = (): { url?: string; opts: RedisOptions } => {
  const mode = readRuntimeMode();
  const modeUrl =
    mode === 'live' ? env.REDIS_URL_LIVE : env.REDIS_URL_TEST;
  const sharedOpts: RedisOptions = {
    db: REDIS_DB,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 10000,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  };
  if (modeUrl) {
    logger.info(`Redis: using URL from REDIS_URL_${mode.toUpperCase()}`);
    return { url: modeUrl, opts: sharedOpts };
  }
  return {
    opts: {
      ...sharedOpts,
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      username: env.REDIS_USERNAME || undefined,
      password: env.REDIS_PASSWORD || undefined,
      ...(useTls ? { tls: { rejectUnauthorized: true } } : {}),
    },
  };
};

const built = buildRedisOptions();
export const redis = built.url
  ? new Redis(built.url, built.opts)
  : new Redis(built.opts);

redis.on('connect', () => logger.info('Redis connected'));
redis.on('ready', () => logger.info('Redis ready'));
redis.on('error', (err) => logger.error('Redis error:', err));
redis.on('close', () => logger.warn('Redis connection closed'));

export const connectRedis = async (): Promise<void> => {
  try {
    await redis.connect();
  } catch (error) {
    logger.error('Failed to connect to Redis:', error);
    throw error;
  }
};

export const disconnectRedis = async (): Promise<void> => {
  await redis.quit();
};

export const CACHE_KEYS = {
  ALL_JOBS: 'jobs:all',
  JOBS_BY_QUERY: (q: string) => `jobs:query:${q}`,
  USER_MATCHED_JOBS: (userId: string) => `jobs:user:${userId}:matched`,
  JOB_BY_ID: (id: string) => `job:${id}`,
  USER_PROFILE: (userId: string) => `user:${userId}:profile`,
  RATE_LIMIT: (ip: string) => `rl:${ip}`,
} as const;
