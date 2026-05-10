import { redis } from '../../config/redis';
import {
  AI_QUOTA_GLOBAL_PER_DAY,
  AI_QUOTA_PER_USER_PER_DAY,
  AI_QUOTA_TIMEZONE,
} from '../../config/constants';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';

/**
 * Daily AI quota tracker (Redis-backed). Two counters:
 *   - per-user (key `ai:q:u:<userId>:<YYYY-MM-DD>`)
 *   - global   (key `ai:q:g:<YYYY-MM-DD>`)
 * Both expire automatically at the next IST midnight; date suffix is in IST.
 *
 * Flow:
 *   1. controller calls `enforceQuota(userId)` BEFORE invoking provider
 *   2. on success: enforceQuota incremented both counters atomically
 *   3. on quota hit: throws ApiError 429 with `details.quota` payload
 *      → frontend reads `resetsAtIso` to render countdown
 */

export interface QuotaSnapshot {
  userUsed: number;
  userLimit: number;
  userRemaining: number;
  globalUsed: number;
  globalLimit: number;
  globalRemaining: number;
  resetsAtIso: string;
  resetsInSec: number;
}

const ymdInTz = (tz: string, d = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '00';
  const day = parts.find((p) => p.type === 'day')?.value ?? '00';
  return `${y}-${m}-${day}`;
};

/**
 * UTC instant of next IST midnight from `now`. Doing this without a TZ
 * library: IST is UTC+5:30 with no DST, so the offset is constant.
 */
const nextIstMidnightUtc = (now = new Date()): Date => {
  const IST_OFFSET_MIN = 330;
  const istNowMs = now.getTime() + IST_OFFSET_MIN * 60_000;
  const istNow = new Date(istNowMs);
  // Construct IST midnight (next day) as a fake-UTC date, then shift back.
  const istMidnight = Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return new Date(istMidnight - IST_OFFSET_MIN * 60_000);
};

const userKey = (userId: string, date: string): string => `ai:q:u:${userId}:${date}`;
const globalKey = (date: string): string => `ai:q:g:${date}`;

const ttlSecondsUntilReset = (now = new Date()): number => {
  const diffMs = nextIstMidnightUtc(now).getTime() - now.getTime();
  return Math.max(60, Math.ceil(diffMs / 1000));
};

const buildSnapshot = (userUsed: number, globalUsed: number, now = new Date()): QuotaSnapshot => {
  const reset = nextIstMidnightUtc(now);
  return {
    userUsed,
    userLimit: AI_QUOTA_PER_USER_PER_DAY,
    userRemaining: Math.max(0, AI_QUOTA_PER_USER_PER_DAY - userUsed),
    globalUsed,
    globalLimit: AI_QUOTA_GLOBAL_PER_DAY,
    globalRemaining: Math.max(0, AI_QUOTA_GLOBAL_PER_DAY - globalUsed),
    resetsAtIso: reset.toISOString(),
    resetsInSec: Math.max(0, Math.floor((reset.getTime() - now.getTime()) / 1000)),
  };
};

/**
 * Read-only snapshot for the frontend's "AI usage" widget.
 */
export const getQuotaSnapshot = async (userId: string): Promise<QuotaSnapshot> => {
  const date = ymdInTz(AI_QUOTA_TIMEZONE);
  const [userRaw, globalRaw] = await redis.mget(userKey(userId, date), globalKey(date));
  return buildSnapshot(Number(userRaw) || 0, Number(globalRaw) || 0);
};

/**
 * Check + reserve one quota slot for `userId`. Throws ApiError(429) with
 * `details.quota` populated if either the user or the global cap is hit.
 * Returns the post-increment snapshot so callers can include it in their
 * success response.
 */
export const enforceQuota = async (userId: string): Promise<QuotaSnapshot> => {
  const now = new Date();
  const date = ymdInTz(AI_QUOTA_TIMEZONE, now);
  const ttl = ttlSecondsUntilReset(now);
  const uKey = userKey(userId, date);
  const gKey = globalKey(date);

  // Pre-check (cheap read) — avoids burning a slot when we'll reject anyway.
  const [userRaw, globalRaw] = await redis.mget(uKey, gKey);
  const userUsed = Number(userRaw) || 0;
  const globalUsed = Number(globalRaw) || 0;

  if (globalUsed >= AI_QUOTA_GLOBAL_PER_DAY) {
    const snap = buildSnapshot(userUsed, globalUsed, now);
    throw new ApiError(429, 'AI free tier daily limit reached for the platform', {
      quota: snap,
      reason: 'global',
    });
  }
  if (userUsed >= AI_QUOTA_PER_USER_PER_DAY) {
    const snap = buildSnapshot(userUsed, globalUsed, now);
    throw new ApiError(429, 'You have used today\'s AI quota', {
      quota: snap,
      reason: 'user',
    });
  }

  // Atomic increment of both counters with TTL bootstrap on first hit.
  const pipe = redis.multi();
  pipe.incr(uKey);
  pipe.expire(uKey, ttl, 'NX');
  pipe.incr(gKey);
  pipe.expire(gKey, ttl, 'NX');
  const result = await pipe.exec();

  // result[0]/[2] are the INCR replies → [null, newValue].
  const newUserUsed =
    result && result[0] && typeof result[0][1] === 'number'
      ? (result[0][1] as number)
      : userUsed + 1;
  const newGlobalUsed =
    result && result[2] && typeof result[2][1] === 'number'
      ? (result[2][1] as number)
      : globalUsed + 1;

  return buildSnapshot(newUserUsed, newGlobalUsed, now);
};

/**
 * Refund a quota slot when the provider call fails before producing a
 * useful result (network error, parse failure). Best-effort — failures
 * here are logged and swallowed; we'd rather over-count than under-count.
 */
export const refundQuota = async (userId: string): Promise<void> => {
  try {
    const date = ymdInTz(AI_QUOTA_TIMEZONE);
    await redis
      .multi()
      .decr(userKey(userId, date))
      .decr(globalKey(date))
      .exec();
  } catch (err) {
    logger.warn(`refundQuota failed: ${(err as Error).message}`);
  }
};
