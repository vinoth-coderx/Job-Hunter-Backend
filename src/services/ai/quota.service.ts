import { redis } from '../../config/redis';
import {
  AI_QUOTA_GLOBAL_PER_DAY,
  AI_QUOTA_PER_USER_PER_DAY,
  AI_QUOTA_TIMEZONE,
} from '../../config/constants';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { User } from '../../models/User';

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
  topUpCredits?: number;
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
 * Read-only snapshot for the frontend's "AI usage" widget. Includes the
 * paid top-up balance so the UI can render "X today + Y pack credits".
 */
export const getQuotaSnapshot = async (userId: string): Promise<QuotaSnapshot> => {
  const date = ymdInTz(AI_QUOTA_TIMEZONE);
  const [userRaw, globalRaw] = await redis.mget(userKey(userId, date), globalKey(date));
  const snap = buildSnapshot(Number(userRaw) || 0, Number(globalRaw) || 0);
  try {
    const user = await User.findById(userId).select('aiTopUpCredits').lean();
    snap.topUpCredits = Math.max(0, Number(user?.aiTopUpCredits ?? 0));
  } catch {
    snap.topUpCredits = 0;
  }
  return snap;
};

/**
 * Atomically attempts to decrement the user's paid top-up balance by
 * `weight`. Returns the new balance on success, or null when the user
 * doesn't have enough credits (no rows mutated).
 */
const tryDebitTopUp = async (
  userId: string,
  weight: number,
): Promise<number | null> => {
  if (weight <= 0) return null;
  try {
    const updated = await User.findOneAndUpdate(
      { _id: userId, aiTopUpCredits: { $gte: weight } },
      { $inc: { aiTopUpCredits: -weight } },
      { new: true, projection: { aiTopUpCredits: 1 } },
    ).lean();
    if (!updated) return null;
    return Math.max(0, Number(updated.aiTopUpCredits ?? 0));
  } catch (err) {
    logger.warn(`tryDebitTopUp failed: ${(err as Error).message}`);
    return null;
  }
};

/**
 * Refund `weight` credits back to the user's top-up balance. Used by
 * `refundQuota` to keep the pack accurate when an AI call fails after a
 * successful debit.
 */
const refundTopUp = async (userId: string, weight: number): Promise<void> => {
  if (weight <= 0) return;
  try {
    await User.updateOne(
      { _id: userId },
      { $inc: { aiTopUpCredits: weight } },
    );
  } catch (err) {
    logger.warn(`refundTopUp failed: ${(err as Error).message}`);
  }
};

/**
 * Check + reserve `weight` quota slots for `userId`. Throws ApiError(429)
 * with `details.quota` populated if either the user or the global cap
 * would be exceeded by the requested charge. Returns the post-increment
 * snapshot so callers can include it in their success response.
 *
 * `weight` defaults to 1 (legacy behaviour). Heavier features pass a
 * larger weight via `getCreditWeight(feature)` from
 * `config/aiCreditWeights.ts` so a single ATS score (weight 3) burns 3
 * slots while a chat message (weight 1) stays cheap.
 *
 * `weight === 0` short-circuits to a snapshot read — cheap-Groq calls
 * (notification rewriter, query expander) are free of quota by design.
 */
export const enforceQuota = async (
  userId: string,
  weight = 1,
): Promise<QuotaSnapshot> => {
  if (weight <= 0) return getQuotaSnapshot(userId);

  const now = new Date();
  const date = ymdInTz(AI_QUOTA_TIMEZONE, now);
  const ttl = ttlSecondsUntilReset(now);
  const uKey = userKey(userId, date);
  const gKey = globalKey(date);

  // Pre-check (cheap read) — avoids burning a slot when we'll reject anyway.
  const [userRaw, globalRaw] = await redis.mget(uKey, gKey);
  const userUsed = Number(userRaw) || 0;
  const globalUsed = Number(globalRaw) || 0;

  // Global cap is the hard infrastructure limit — even paid users can't
  // bypass it (otherwise a single rich user could deplete the free-tier
  // upstream quota for everyone). Reject before consulting the pack.
  if (globalUsed + weight > AI_QUOTA_GLOBAL_PER_DAY) {
    const snap = buildSnapshot(userUsed, globalUsed, now);
    throw new ApiError(429, 'AI free tier daily limit reached for the platform', {
      quota: snap,
      reason: 'global',
    });
  }

  // Try the user's daily free allowance first — that way pack credits
  // last as long as possible and aren't burnt while free slots remain.
  if (userUsed + weight <= AI_QUOTA_PER_USER_PER_DAY) {
    const pipe = redis.multi();
    pipe.incrby(uKey, weight);
    pipe.expire(uKey, ttl, 'NX');
    pipe.incrby(gKey, weight);
    pipe.expire(gKey, ttl, 'NX');
    const result = await pipe.exec();

    const newUserUsed =
      result && result[0] && typeof result[0][1] === 'number'
        ? (result[0][1] as number)
        : userUsed + weight;
    const newGlobalUsed =
      result && result[2] && typeof result[2][1] === 'number'
        ? (result[2][1] as number)
        : globalUsed + weight;

    const snap = buildSnapshot(newUserUsed, newGlobalUsed, now);
    // Surface the pack balance so the UI keeps it in sync even on
    // free-tier-only debits.
    try {
      const u = await User.findById(userId).select('aiTopUpCredits').lean();
      snap.topUpCredits = Math.max(0, Number(u?.aiTopUpCredits ?? 0));
    } catch {
      /* best effort */
    }
    return snap;
  }

  // Free tier exhausted — try the paid pack. Global INCR still happens
  // so the upstream-budget counter stays honest.
  const newPackBalance = await tryDebitTopUp(userId, weight);
  if (newPackBalance !== null) {
    const pipe = redis.multi();
    pipe.incrby(gKey, weight);
    pipe.expire(gKey, ttl, 'NX');
    const result = await pipe.exec();
    const newGlobalUsed =
      result && result[0] && typeof result[0][1] === 'number'
        ? (result[0][1] as number)
        : globalUsed + weight;
    const snap = buildSnapshot(userUsed, newGlobalUsed, now);
    snap.topUpCredits = newPackBalance;
    return snap;
  }

  // Neither lane has room — surface the 429 with the pack balance so the
  // client can route to the top-up sheet directly.
  const snap = buildSnapshot(userUsed, globalUsed, now);
  try {
    const u = await User.findById(userId).select('aiTopUpCredits').lean();
    snap.topUpCredits = Math.max(0, Number(u?.aiTopUpCredits ?? 0));
  } catch {
    snap.topUpCredits = 0;
  }
  throw new ApiError(429, 'You have used today\'s AI quota', {
    quota: snap,
    reason: 'user',
  });
};

/**
 * Refund `weight` slots when the provider call fails before producing a
 * useful result (network error, parse failure). Best-effort — failures
 * here are logged and swallowed; we'd rather over-count than under-count.
 *
 * Pass the SAME weight you debited via enforceQuota; mismatched refunds
 * silently leak counter capacity for the rest of the day.
 */
export const refundQuota = async (
  userId: string,
  weight = 1,
): Promise<void> => {
  if (weight <= 0) return;
  try {
    const date = ymdInTz(AI_QUOTA_TIMEZONE);
    const uKey = userKey(userId, date);
    const userUsed = Number(await redis.get(uKey)) || 0;

    // The original debit went to whichever lane had room — we mirror
    // that decision on refund. If the daily counter has at least
    // `weight` already burned today, the debit came from there; refund
    // it. Otherwise the pack ate the charge — refund that instead.
    if (userUsed >= weight) {
      await redis
        .multi()
        .decrby(uKey, weight)
        .decrby(globalKey(date), weight)
        .exec();
    } else {
      await refundTopUp(userId, weight);
      await redis.decrby(globalKey(date), weight);
    }
  } catch (err) {
    logger.warn(`refundQuota failed: ${(err as Error).message}`);
  }
};
