import cron, { ScheduledTask } from 'node-cron';
import { getAppConfig } from '../services/config/config.service';
import { logger } from '../utils/logger';

// A cron toggle stored as a string ('true'/'false') in AppConfig or as
// the legacy boolean env var. Default = enabled; only the explicit
// "false" string flips it off.
const cronsEnabled = (): boolean => getAppConfig('CRON_ENABLED') !== 'false';
import { fetchAllJobs } from '../services/scrapers';
import { Subscription } from '../models/Subscription';
import { User } from '../models/User';
import { AppliedJob } from '../models/AppliedJob';
import { trackedCron, getCronSchedule } from '../utils/cronTracker';

// Third-party jobs are fetched live per request now (see jobFeed.service),
// so the hourly fetch-and-store cron is retired. This module still owns
// the DB-hygiene tasks (subscription expiry, applied-jobs purge) and
// exposes `runJobFetchNow` as an admin escape hatch for one-off
// hydration / debug runs.

let subscriptionCheckerTask: ScheduledTask | null = null;
let appliedJobsCleanupTask: ScheduledTask | null = null;
let isRunning = false;

// How long an applied-job record sticks around. Anything older is purged
// nightly so the seeker's "Applied" feed stays focused on actionable
// recent activity.
export const APPLIED_JOB_RETENTION_DAYS = 90;

// User-visible window for the Applied list. Records older than this are
// hidden from the UI even though they still live in the DB until the
// retention sweep removes them. Kept shorter than retention so a future
// "show all history" toggle can still surface the buffered records.
export const APPLIED_JOB_VIEW_DAYS = 30;

/**
 * Extracted cron bodies — named exports so the admin "Run Now" endpoint
 * can invoke the same code path the scheduler uses, without duplicating
 * the logic inline inside `cron.schedule()` callbacks.
 */
export const runSubscriptionCheckNow = async (): Promise<void> => {
  logger.info('Cron: expiring stale subscriptions');
  const expired = await Subscription.updateMany(
    { status: 'active', endDate: { $lt: new Date() } },
    { $set: { status: 'expired' } },
  );
  if (expired.modifiedCount > 0) {
    const expiredSubs = await Subscription.find({ status: 'expired' }).distinct('user');
    await User.updateMany(
      { _id: { $in: expiredSubs } },
      { $set: { 'subscription.tier': 'free', 'subscription.status': 'expired' } },
    );
    logger.info(`Expired ${expired.modifiedCount} subscriptions`);
  }
};

export const runAppliedJobsCleanupNow = async (): Promise<void> => {
  const cutoff = new Date(
    Date.now() - APPLIED_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const result = await AppliedJob.deleteMany({ appliedAt: { $lt: cutoff } });
  if (result.deletedCount > 0) {
    logger.info(
      `Cron: purged ${result.deletedCount} applied-job records older than ${APPLIED_JOB_RETENTION_DAYS} days`,
    );
  }
};

export const startJobScraperCron = (): void => {
  if (!cronsEnabled()) {
    logger.info('Cron disabled by config');
    return;
  }

  const subSchedule = getCronSchedule('subscriptionChecker');
  const cleanupSchedule = getCronSchedule('appliedJobsCleanup');

  if (!cron.validate(subSchedule)) {
    logger.error(`Invalid subscriptionChecker cron: ${subSchedule}`);
  } else {
    subscriptionCheckerTask = cron.schedule(
      subSchedule,
      trackedCron('subscriptionChecker', runSubscriptionCheckNow),
      { timezone: 'Asia/Kolkata' },
    );
  }

  if (!cron.validate(cleanupSchedule)) {
    logger.error(`Invalid appliedJobsCleanup cron: ${cleanupSchedule}`);
  } else {
    appliedJobsCleanupTask = cron.schedule(
      cleanupSchedule,
      trackedCron('appliedJobsCleanup', runAppliedJobsCleanupNow),
      { timezone: 'Asia/Kolkata' },
    );
  }

  logger.info(
    `Cron scheduled — sub check: "${subSchedule}", applied-jobs cleanup: "${cleanupSchedule}" (>${APPLIED_JOB_RETENTION_DAYS}d)`,
  );
};

export const stopJobScraperCron = (): void => {
  if (subscriptionCheckerTask) {
    subscriptionCheckerTask.stop();
    subscriptionCheckerTask = null;
  }
  if (appliedJobsCleanupTask) {
    appliedJobsCleanupTask.stop();
    appliedJobsCleanupTask = null;
  }
  logger.info('Cron stopped');
};

/**
 * Admin escape hatch — runs the legacy "fetch and write to DB" pipeline
 * for one-off hydration or debugging. Production reads no longer depend
 * on this; live third-party data flows through jobFeed.service per
 * request. Leaving the door open lets us seed a fresh DB or chase a
 * regression without re-enabling the cron.
 */
export const runJobFetchNow = async () => {
  if (isRunning) throw new Error('A job fetch is already in progress');
  isRunning = true;
  try {
    return await fetchAllJobs();
  } finally {
    isRunning = false;
  }
};
