import cron, { ScheduledTask } from 'node-cron';
import { logger } from '../utils/logger';
import { trackedCron, getCronSchedule } from '../utils/cronTracker';
import { getAppConfig } from '../services/config/config.service';
import { HirerProfile } from '../models/HirerProfile';
import { recomputeHirerTrust } from '../services/security/trustScore.service';
import { sweepInactiveSessions } from '../services/security/session.service';
import { Verification } from '../models/Verification';

const cronsEnabled = (): boolean => getAppConfig('CRON_ENABLED') !== 'false';

let task: ScheduledTask | null = null;
let isRunning = false;

/// One pass: recompute every hirer's trustScore + dailyPostLimit, then
/// revoke sessions that haven't had activity in the configured window.
/// Runs at 03:15 IST so it doesn't collide with alertChecker (which
/// runs on the :00/:15/:30/:45 ticks every 15 min).
export const runTrustMaintenanceNow = async (): Promise<void> => {
  const hirers = await HirerProfile.find().select('user').lean();
  let updated = 0;
  for (const h of hirers) {
    try {
      await recomputeHirerTrust(h.user);
      updated += 1;
    } catch (err) {
      logger.warn(`[trustMaintenance] failed for ${h.user}: ${(err as Error).message}`);
    }
  }
  const sweptSessions = await sweepInactiveSessions();
  // Mark stale `pending` verifications as expired so they drop out of
  // the admin queue. The hirer can re-submit; the audit history is
  // preserved because we don't delete — we transition status.
  const expiryCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const expired = await Verification.updateMany(
    { status: 'pending', createdAt: { $lt: expiryCutoff } },
    { $set: { status: 'expired' } },
  );
  logger.info(
    `[trustMaintenance] recomputed ${updated}/${hirers.length} hirers, swept ${sweptSessions} sessions, expired ${expired.modifiedCount ?? 0} verifications`,
  );
};

export const startTrustMaintenanceCron = (): void => {
  if (!cronsEnabled()) return;
  const schedule = getCronSchedule('trustMaintenance');
  if (!cron.validate(schedule)) {
    logger.error(`Invalid trustMaintenance cron expression: ${schedule}`);
    return;
  }
  task = cron.schedule(
    schedule,
    trackedCron('trustMaintenance', async () => {
      if (isRunning) {
        logger.warn('trustMaintenance: previous tick still running — skipping');
        return;
      }
      isRunning = true;
      const start = Date.now();
      try {
        await runTrustMaintenanceNow();
        logger.info(`trustMaintenance: tick complete in ${Date.now() - start}ms`);
      } finally {
        isRunning = false;
      }
    }),
    { timezone: 'Asia/Kolkata' },
  );
  logger.info(`trustMaintenance cron scheduled: "${schedule}"`);
};

export const stopTrustMaintenanceCron = (): void => {
  if (task) {
    task.stop();
    task = null;
  }
};
