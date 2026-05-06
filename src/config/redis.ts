import Redis, { RedisOptions } from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

const useTls = env.REDIS_TLS === 'true';

const redisOpts: RedisOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  username: env.REDIS_USERNAME || undefined,
  password: env.REDIS_PASSWORD || undefined,
  db: env.REDIS_DB,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
  connectTimeout: 10000,
  retryStrategy: (times) => Math.min(times * 200, 5000),
  ...(useTls ? { tls: { rejectUnauthorized: true } } : {}),
};

export const redis = new Redis(redisOpts);

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
