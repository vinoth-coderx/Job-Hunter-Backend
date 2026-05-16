import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { User } from '../src/models/User';
import { HirerProfile } from '../src/models/HirerProfile';
import {
  recomputeHirerTrust,
  recomputeUserTrust,
} from '../src/services/security/trustScore.service';
import { logger } from '../src/utils/logger';

/**
 * One-shot backfill — recomputes every recruiter's trustScore +
 * dailyPostLimit and every user's security.trustScore. Run once after
 * deploying the trust-and-safety stack on a database that already has
 * existing accounts; the nightly cron handles ongoing maintenance.
 *
 *   npm run backfill:trust
 *
 * Idempotent. Safe to re-run. Skips users/hirers it can't process
 * instead of exiting on first error so a single bad row doesn't block
 * the rest of the run.
 */

interface RunStats {
  hirers: { ok: number; failed: number; total: number };
  users: { ok: number; failed: number; total: number };
  ms: number;
}

const backfillHirers = async (): Promise<RunStats['hirers']> => {
  const hirers = await HirerProfile.find().select('user').lean();
  let ok = 0;
  let failed = 0;
  for (const h of hirers) {
    try {
      await recomputeHirerTrust(h.user);
      ok += 1;
    } catch (err) {
      failed += 1;
      logger.warn(`[backfill] hirer ${h.user} failed: ${(err as Error).message}`);
    }
  }
  return { ok, failed, total: hirers.length };
};

const backfillUsers = async (): Promise<RunStats['users']> => {
  const users = await User.find().select('_id').lean();
  let ok = 0;
  let failed = 0;
  for (const u of users) {
    try {
      await recomputeUserTrust(u._id);
      ok += 1;
    } catch (err) {
      failed += 1;
      logger.warn(`[backfill] user ${u._id} failed: ${(err as Error).message}`);
    }
  }
  return { ok, failed, total: users.length };
};

(async () => {
  const t0 = Date.now();
  try {
    await connectDatabase();
    logger.info('[backfill] starting trust recomputation…');
    const hirers = await backfillHirers();
    logger.info(
      `[backfill] hirers: ${hirers.ok}/${hirers.total} ok, ${hirers.failed} failed`,
    );
    const users = await backfillUsers();
    logger.info(
      `[backfill] users: ${users.ok}/${users.total} ok, ${users.failed} failed`,
    );
    const ms = Date.now() - t0;
    logger.info(`[backfill] done in ${ms}ms`);
  } catch (err) {
    logger.error('[backfill] aborted', err);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => {});
  }
})();
