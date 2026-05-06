import cron, { ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { fetchAllJobs } from '../services/scrapers';
import { warmJobsCache } from '../services/jobCache.service';
import { Subscription } from '../models/Subscription';
import { User } from '../models/User';

let jobScraperTask: ScheduledTask | null = null;
let subscriptionCheckerTask: ScheduledTask | null = null;
let cacheWarmTask: ScheduledTask | null = null;
let isRunning = false;

export const startJobScraperCron = (): void => {
  if (!env.CRON_ENABLED) {
    logger.info('Cron disabled by config');
    return;
  }

  if (!cron.validate(env.CRON_JOB_FETCH_SCHEDULE)) {
    logger.error(`Invalid cron expression: ${env.CRON_JOB_FETCH_SCHEDULE}`);
    return;
  }

  jobScraperTask = cron.schedule(
    env.CRON_JOB_FETCH_SCHEDULE,
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

  if (cron.validate(env.CRON_CACHE_WARM_SCHEDULE)) {
    cacheWarmTask = cron.schedule(
      env.CRON_CACHE_WARM_SCHEDULE,
      async () => {
        try {
          const result = await warmJobsCache();
          logger.info('Cron: cache warmed', result);
        } catch (err) {
          logger.error('Cron: cache warm failed', err);
        }
      },
      { timezone: 'Asia/Kolkata' },
    );
  } else {
    logger.error(`Invalid cache warm cron: ${env.CRON_CACHE_WARM_SCHEDULE}`);
  }

  logger.info(
    `Cron scheduled — job fetch: "${env.CRON_JOB_FETCH_SCHEDULE}", cache warm: "${env.CRON_CACHE_WARM_SCHEDULE}", sub check: daily 00:00`,
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
  if (cacheWarmTask) {
    cacheWarmTask.stop();
    cacheWarmTask = null;
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
