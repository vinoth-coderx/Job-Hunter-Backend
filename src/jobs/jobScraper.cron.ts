import cron, { ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { CRON_JOB_FETCH_SCHEDULE } from '../config/constants';
import { logger } from '../utils/logger';
import { fetchAllJobs } from '../services/scrapers';
import { Subscription } from '../models/Subscription';
import { User } from '../models/User';
import { AppliedJob } from '../models/AppliedJob';

let jobScraperTask: ScheduledTask | null = null;
let subscriptionCheckerTask: ScheduledTask | null = null;
let appliedJobsCleanupTask: ScheduledTask | null = null;
let isRunning = false;

// How long an applied-job record sticks around. Anything older is purged
// nightly so the seeker's "Applied" feed stays focused on actionable
// recent activity.
export const APPLIED_JOB_RETENTION_DAYS = 90;

export const startJobScraperCron = (): void => {
  if (!env.CRON_ENABLED) {
    logger.info('Cron disabled by config');
    return;
  }

  if (!cron.validate(CRON_JOB_FETCH_SCHEDULE)) {
    logger.error(`Invalid cron expression: ${CRON_JOB_FETCH_SCHEDULE}`);
    return;
  }

  jobScraperTask = cron.schedule(
    CRON_JOB_FETCH_SCHEDULE,
    async () => {
      if (isRunning) {
        logger.warn('Previous job fetch still running — skipping this tick');
        return;
      }
      isRunning = true;
      const start = Date.now();
      try {
        logger.info('Cron: starting hourly job fetch');
        const result = await fetchAllJobs();
        logger.info(`Cron: job fetch complete in ${Date.now() - start}ms`, result);
      } catch (err) {
        logger.error('Cron: job fetch failed', err);
      } finally {
        isRunning = false;
      }
    },
    { timezone: 'Asia/Kolkata' },
  );

  subscriptionCheckerTask = cron.schedule(
    '0 0 * * *',
    async () => {
      try {
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
      } catch (err) {
        logger.error('Cron: subscription expiry check failed', err);
      }
    },
    { timezone: 'Asia/Kolkata' },
  );

  // Nightly cleanup of applied-job records older than the retention window.
  // Runs at 02:00 IST so it doesn't overlap the daily subscription check.
  appliedJobsCleanupTask = cron.schedule(
    '0 2 * * *',
    async () => {
      try {
        const cutoff = new Date(
          Date.now() - APPLIED_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        );
        const result = await AppliedJob.deleteMany({ appliedAt: { $lt: cutoff } });
        if (result.deletedCount > 0) {
          logger.info(
            `Cron: purged ${result.deletedCount} applied-job records older than ${APPLIED_JOB_RETENTION_DAYS} days`,
          );
        }
      } catch (err) {
        logger.error('Cron: applied-jobs cleanup failed', err);
      }
    },
    { timezone: 'Asia/Kolkata' },
  );

  logger.info(
    `Cron scheduled — job fetch: "${CRON_JOB_FETCH_SCHEDULE}", sub check: daily 00:00, applied-jobs cleanup: daily 02:00 (>${APPLIED_JOB_RETENTION_DAYS}d)`,
  );
};

export const stopJobScraperCron = (): void => {
  if (jobScraperTask) {
    jobScraperTask.stop();
    jobScraperTask = null;
  }
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

export const runJobFetchNow = async () => {
  if (isRunning) throw new Error('A job fetch is already in progress');
  isRunning = true;
  try {
    return await fetchAllJobs();
  } finally {
    isRunning = false;
  }
};
