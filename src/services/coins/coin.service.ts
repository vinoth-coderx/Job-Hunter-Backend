import mongoose from 'mongoose';
import { User, IUser } from '../../models/User';
import { CoinLedger, CoinSource } from '../../models/CoinLedger';
import { logger } from '../../utils/logger';
import { completenessFromUser } from '../profile/completeness.service';

// One-shot reward when the seeker first hits 100% profile completeness.
// "Resume 100%" in the project's coin economy doc actually maps to the
// whole profile being filled out — the resume's the heaviest single
// weight (30 of 100), so the labels rhyme even though the metric is
// the full completeness score.
const PROFILE_COMPLETE_COIN_AMOUNT = 50;
const PROFILE_COMPLETE_KEY = 'profile_complete:v1';

export interface GrantCoinsInput {
  user: mongoose.Types.ObjectId | string;
  amount: number;
  source: CoinSource;
  // Compound idempotency key per user. Same (user, key) tuple will be
  // rejected as duplicate so the same earn-event can't credit twice
  // even if the caller fires twice (network retry, double-tap, etc).
  idempotencyKey: string;
  sourceRefId?: string;
  meta?: Record<string, unknown>;
  // Optional per-(user, source) daily ceiling. Once today's earnings
  // from this source meet or exceed the cap, further grants short-
  // circuit. Used to stop farming via spam-applies / spam-shares.
  // When provided and the current grant would partially fit, we grant
  // exactly the remaining headroom (so users still see *some* reward
  // up to the cap).
  dailyCap?: number;
}

export interface GrantCoinsResult {
  granted: boolean;
  amount: number; // Actual delta applied (0 when granted=false).
  balance: number; // Post-mutation balance.
  reason?:
    | 'duplicate'
    | 'invalid_amount'
    | 'user_not_found'
    | 'daily_cap';
}

const startOfToday = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const sumTodayForSource = async (
  userId: mongoose.Types.ObjectId,
  source: CoinSource,
): Promise<number> => {
  const since = startOfToday();
  const agg = await CoinLedger.aggregate<{ total: number }>([
    {
      $match: {
        user: userId,
        source,
        amount: { $gt: 0 },
        createdAt: { $gte: since },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return agg[0]?.total ?? 0;
};

/**
 * Atomically grants (or deducts when amount<0) coins to a user.
 *
 * Anti-abuse pattern:
 *   1. Insert ledger row first — the `(user, idempotencyKey)` unique
 *      index rejects replays. If insert fails on duplicate, we never
 *      touch the wallet.
 *   2. Only on a successful ledger insert do we $inc the user wallet.
 *      If the $inc somehow fails after the insert (very rare), we'd
 *      have an orphaned ledger row with no balance change — which is
 *      strictly safer than the inverse (uncounted grant).
 *   3. We persist `balanceAfter` so reconciliation never requires
 *      replaying the whole log.
 */
export const grantCoins = async (
  input: GrantCoinsInput,
): Promise<GrantCoinsResult> => {
  const { user, source, idempotencyKey, sourceRefId, meta, dailyCap } = input;
  let { amount } = input;
  if (!Number.isFinite(amount) || amount === 0) {
    return { granted: false, amount: 0, balance: 0, reason: 'invalid_amount' };
  }

  const userId =
    typeof user === 'string' ? new mongoose.Types.ObjectId(user) : user;

  // Pre-flight: confirm the user exists and capture pre-balance for the
  // ledger snapshot. We re-read after the $inc to fill `balanceAfter`,
  // so this is just a guard against ghost user IDs.
  const userDoc = await User.findById(userId).select('gamification.coins');
  if (!userDoc) {
    return { granted: false, amount: 0, balance: 0, reason: 'user_not_found' };
  }

  // Daily-cap clamp (positive grants only). Race window is fine: two
  // concurrent grants near the cap could both pass, leaking at most
  // one extra grant — the unique idempotency key still blocks per-
  // event double-credits, which is the primary abuse vector.
  if (dailyCap && dailyCap > 0 && amount > 0) {
    const earnedToday = await sumTodayForSource(userId, source);
    const remaining = dailyCap - earnedToday;
    if (remaining <= 0) {
      return {
        granted: false,
        amount: 0,
        balance: userDoc.gamification?.coins ?? 0,
        reason: 'daily_cap',
      };
    }
    if (remaining < amount) amount = remaining;
  }

  // Step 1: insert ledger row (will throw E11000 on duplicate idemp key).
  // We write balanceAfter = current + amount up-front and then patch it
  // post-$inc if there's drift (concurrent grants).
  const provisionalBalance = Math.max(
    0,
    (userDoc.gamification?.coins ?? 0) + amount,
  );

  let ledgerId: mongoose.Types.ObjectId;
  try {
    const ledger = await CoinLedger.create({
      user: userId,
      amount,
      source,
      idempotencyKey,
      sourceRefId,
      balanceAfter: provisionalBalance,
      meta,
    });
    ledgerId = ledger._id;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: number }).code === 11000
    ) {
      // Replay — the user already received this grant. Return current
      // balance so callers can keep the UI in sync.
      return {
        granted: false,
        amount: 0,
        balance: userDoc.gamification?.coins ?? 0,
        reason: 'duplicate',
      };
    }
    throw err;
  }

  // Step 2: atomic $inc. Use findOneAndUpdate with $inc + clamp via
  // condition so the balance never goes negative on a deduction.
  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      // Block deductions that would push balance below zero. Grants
      // (amount>0) always satisfy this.
      ...(amount < 0 ? { 'gamification.coins': { $gte: -amount } } : {}),
    },
    { $inc: { 'gamification.coins': amount } },
    { new: true, projection: { 'gamification.coins': 1 } },
  );

  if (!updated) {
    // Deduction couldn't go through (insufficient balance). Roll back
    // the ledger row since no actual mutation happened.
    await CoinLedger.deleteOne({ _id: ledgerId });
    return {
      granted: false,
      amount: 0,
      balance: userDoc.gamification?.coins ?? 0,
      reason: 'invalid_amount',
    };
  }

  const finalBalance = updated.gamification?.coins ?? provisionalBalance;
  if (finalBalance !== provisionalBalance) {
    // Concurrent grant landed between our read and inc — patch the
    // snapshot so the ledger reflects reality.
    await CoinLedger.updateOne(
      { _id: ledgerId },
      { $set: { balanceAfter: finalBalance } },
    ).catch((e) => logger.warn('Coin ledger snapshot patch failed', e));
  }

  return { granted: true, amount, balance: finalBalance };
};

/**
 * Read-only balance lookup. Cheap — single field projection.
 */
export const getBalance = async (
  userId: mongoose.Types.ObjectId | string,
): Promise<number> => {
  const u = await User.findById(userId).select('gamification.coins').lean();
  return u?.gamification?.coins ?? 0;
};

/**
 * Fires the one-time profile-completion bonus when the seeker has
 * reached 100% completeness. Idempotent at the ledger level — the
 * `profile_complete:v1` key never re-grants, even if the user's
 * completeness dips and recovers later.
 *
 * Returns the grant result on a fresh grant, or `null` when the user
 * isn't yet eligible. A duplicate (already granted before) returns a
 * GrantCoinsResult with `granted=false` and the current balance, so
 * callers can still surface the up-to-date wallet.
 */
export const maybeGrantProfileCompleteBonus = async (
  user: IUser,
): Promise<GrantCoinsResult | null> => {
  const completeness = completenessFromUser(user);
  if (completeness < 100) return null;
  return grantCoins({
    user: user._id,
    amount: PROFILE_COMPLETE_COIN_AMOUNT,
    source: 'resume_complete',
    idempotencyKey: PROFILE_COMPLETE_KEY,
    meta: { completeness },
  });
};
