import Redis, { RedisOptions } from 'ioredis';
import { env } from './env';
import { REDIS_DB } from './constants';
import { currentRuntimeMode, type RuntimeMode } from './dbConnections';
import { logger } from '../utils/logger';

/**
 * Dual-mode Redis. The HTTP server is mode-aware via
 * AsyncLocalStorage, so the exported `redis` symbol is a Proxy that
 * dispatches to whichever client matches the active runtime mode.
 *
 * Isolation strategy (cheapest first):
 *   1. If `REDIS_URL_{TEST,LIVE}` is set, use that per-mode URL —
 *      fully separate Redis instances.
 *   2. Otherwise share one instance but pick different logical DBs
 *      (test → REDIS_DB, live → REDIS_DB + 1) so keys don't collide.
 *
 * Either way callers keep using `import { redis } from '../config/redis'`
 * unchanged — no caller cares which mode they're in.
 */
const useTls = env.REDIS_TLS === 'true';

const sharedOpts: RedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
  connectTimeout: 10000,
  retryStrategy: (times) => Math.min(times * 200, 5000),
};

const buildClient = (mode: RuntimeMode): Redis => {
  const url = mode === 'live' ? env.REDIS_URL_LIVE : env.REDIS_URL_TEST;
  if (url) {
    logger.info(`Redis[${mode}]: using REDIS_URL_${mode.toUpperCase()}`);
    return new Redis(url, sharedOpts);
  }
  // Fall back to the discrete REDIS_* quintet. Both modes connect to
  // the same instance + same DB when separate URLs aren't configured —
  // most managed Redis tiers (Redis Cloud free, Upstash) only expose
  // a single logical DB so we can't auto-isolate. Operators wanting
  // strict isolation should set REDIS_URL_TEST + REDIS_URL_LIVE.
  return new Redis({
    ...sharedOpts,
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    username: env.REDIS_USERNAME || undefined,
    password: env.REDIS_PASSWORD || undefined,
    db: REDIS_DB,
    ...(useTls ? { tls: { rejectUnauthorized: true } } : {}),
  });
};

const clients: Record<RuntimeMode, Redis> = {
  test: buildClient('test'),
  live: buildClient('live'),
};

(['test', 'live'] as const).forEach((mode) => {
  const c = clients[mode];
  c.on('connect', () => logger.info(`Redis[${mode}] connected`));
  c.on('ready', () => logger.info(`Redis[${mode}] ready`));
  c.on('error', (err) => logger.error(`Redis[${mode}] error:`, err));
  c.on('close', () => logger.warn(`Redis[${mode}] connection closed`));
});

const resolveClient = (): Redis => clients[currentRuntimeMode()];

const handler: ProxyHandler<Redis> = {
  get(_target, prop) {
    const c = resolveClient();
    const value = Reflect.get(c, prop, c);
    if (typeof value === 'function') return value.bind(c);
    return value;
  },
  set(_target, prop, value) {
    const c = resolveClient();
    return Reflect.set(c, prop, value);
  },
  has(_target, prop) {
    const c = resolveClient();
    return Reflect.has(c, prop);
  },
};

export const redis = new Proxy(clients.live, handler);

export const connectRedis = async (): Promise<void> => {
  await Promise.all([clients.test.connect(), clients.live.connect()]).catch(
    (err) => {
      logger.error('Failed to connect to one or more Redis clients:', err);
      throw err;
    },
  );
};

export const disconnectRedis = async (): Promise<void> => {
  await Promise.all([clients.test.quit(), clients.live.quit()]);
};

export const CACHE_KEYS = {
  ALL_JOBS: 'jobs:all',
  JOBS_BY_QUERY: (q: string) => `jobs:query:${q}`,
  USER_MATCHED_JOBS: (userId: string) => `jobs:user:${userId}:matched`,
  JOB_BY_ID: (id: string) => `job:${id}`,
  USER_PROFILE: (userId: string) => `user:${userId}:profile`,
  RATE_LIMIT: (ip: string) => `rl:${ip}`,
} as const;
