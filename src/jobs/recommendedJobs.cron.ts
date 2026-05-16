import cron, { ScheduledTask } from 'node-cron';

import { Job, IJob } from '../models/Job';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { getAppConfig } from '../services/config/config.service';
import { notifyUser } from '../services/notification/notify.service';
import { sendRecommendedJobEmail } from '../services/notification/email.service';
import { scoreForAutoApply } from '../services/autoApply/scorer';
import { trackedCron, getCronSchedule } from '../utils/cronTracker';
import { logger } from '../utils/logger';

const cronsEnabled = (): boolean => getAppConfig('CRON_ENABLED') !== 'false';

// Floor for what counts as a "recommend now" match. Mirrors the
// highMatchAlerts threshold the Flutter shell already uses for the
// in-app banner so push + banner agree on what's worth interrupting
// the user for.
const MATCH_THRESHOLD = 70;

// Per-tick safety caps. Sized so the worst-case run fits inside the
// 30-minute schedule on the Render free tier (each user costs ~1
// Mongo find + N in-process scores).
const MAX_USERS_PER_RUN = 200;
const MAX_JOBS_PER_USER_SCAN = 60;

// First-run lookback: a brand-new account has no cursor, so use a
// 24-hour window to bootstrap without flooding them with stale jobs.
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

let task: ScheduledTask | null = null;
let isRunning = false;

/// Compact salary preview for the email — the body only has room for
/// one line. Falls back to `undefined` (caller skips the line) when no
/// salary is on the listing.
const formatSalary = (job: IJob): string | undefined => {
  const min = job.salaryMin;
  const max = job.salaryMax;
  const fmt = (n: number) =>
    n >= 100000 ? `${(n / 100000).toFixed(1).replace(/\.0$/, '')}L` : `${Math.round(n / 1000)}k`;
  if (min && max && min !== max) return `₹${fmt(min)}–${fmt(max)}`;
  if (max) return `₹${fmt(max)}`;
  if (min) return `₹${fmt(min)}+`;
  return undefined;
};

/**
 * System-recommended high-match push.
 *
 * Distinct from `alertChecker` (which only fires for jobs matching a
 * user-created saved alert) — this cron scans every active seeker,
 * scores recently-posted native jobs against their profile, and pushes
 * one notification per tick when the top candidate clears the match
 * threshold. The seeker doesn't have to configure anything; the moment
 * their resume + preferences exist we start surfacing matches.
 *
 * Dedupe strategy:
 *   1. `lastRecommendedPushAt` cursor per user — only consider jobs
 *      posted after the last push.
 *   2. Defensive Notification lookup — if we already pushed the same
 *      `jobId` to this user in the last 24h, skip and re-advance the
 *      cursor. Guards against a clock skew / cursor-write failure
 *      double-notifying.
 */
export const checkRecommendedJobsNow = async (): Promise<void> => {
  // Pull only the seekers who have push + jobAlerts enabled. The
  // notifyUser call also re-checks `notificationPreferences.push`, but
  // filtering up front keeps the per-tick cost proportional to opt-in
  // users only.
  const seekers = await User.find({
    activeRole: 'seeker',
    isBanned: { $ne: true },
    'notificationPreferences.push': { $ne: false },
    'notificationPreferences.jobAlerts': { $ne: false },
  })
    .select(
      '_id email profile notificationPreferences lastRecommendedPushAt',
    )
    .limit(MAX_USERS_PER_RUN);

  for (const user of seekers) {
    try {
      // Skip seekers with no signals to match against — scoring with no
      // skills / no roles / no locations produces a meaningless floor.
      const hasSignals =
        (user.profile?.skills?.length ?? 0) > 0 ||
        (user.profile?.preferredRoles?.length ?? 0) > 0 ||
        (user.profile?.preferredLocations?.length ?? 0) > 0;
      if (!hasSignals) continue;

      const sinceCutoff =
        user.lastRecommendedPushAt ??
        new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);

      const candidates = await Job.find({
        isNative: true,
        isActive: true,
        postedAt: { $gt: sinceCutoff },
      })
        .sort({ postedAt: -1 })
        .limit(MAX_JOBS_PER_USER_SCAN);

      if (candidates.length === 0) continue;

      let topJob: IJob | null = null;
      let topScore = 0;
      for (const job of candidates) {
        const { total } = scoreForAutoApply(user, job);
        if (total >= MATCH_THRESHOLD && total > topScore) {
          topScore = total;
          topJob = job;
        }
      }

      // Even when nothing crossed the threshold, advance the cursor —
      // re-scoring the same pool every 30 min is pure waste, and a job
      // that didn't score 70% today won't suddenly score higher
      // tomorrow without a profile change.
      const now = new Date();
      if (!topJob) {
        user.lastRecommendedPushAt = now;
        await user.save();
        continue;
      }

      // Defensive de-dupe: if the same jobId was already pushed to this
      // user within the last 24h, drop and keep the cursor moving.
      const dupeWindow = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const alreadyPushed = await Notification.exists({
        user: user._id,
        type: 'new_job_match',
        'data.jobId': topJob._id.toString(),
        createdAt: { $gt: dupeWindow },
      });
      if (alreadyPushed) {
        user.lastRecommendedPushAt = now;
        await user.save();
        continue;
      }

      await notifyUser({
        user: user._id,
        role: 'seeker',
        type: 'new_job_match',
        title: `${topScore}% match · ${topJob.title}`,
        body: `${topJob.company}${topJob.location ? ` · ${topJob.location}` : ''}`,
        data: {
          jobId: topJob._id.toString(),
          matchScore: topScore,
          source: 'recommended',
        },
      });

      // Email mirror — same match, same deep link, gated on the user's
      // email preference. We fire it after the push so a transient SMTP
      // failure doesn't drop the in-app notification too. Non-blocking
      // because email send time is dominated by SMTP RTT, not Mongo.
      if (user.notificationPreferences?.email !== false && user.email) {
        const salaryText = formatSalary(topJob);
        void sendRecommendedJobEmail({
          toEmail: user.email,
          fullName: user.profile?.fullName ?? 'there',
          job: {
            id: topJob._id.toString(),
            title: topJob.title,
            company: topJob.company,
            location: topJob.location,
            salaryText,
            matchScore: topScore,
          },
        }).catch((err) => {
          logger.warn(
            `RecommendedJobs: email send failed for ${user._id}: ${
              (err as Error).message
            }`,
          );
        });
      }

      user.lastRecommendedPushAt = now;
      await user.save();
    } catch (err) {
      logger.error(
        `RecommendedJobs: failed for user ${user._id}: ${(err as Error).message}`,
      );
    }
  }
};

export const startRecommendedJobsCron = (): void => {
  if (!cronsEnabled()) return;
  const schedule = getCronSchedule('recommendedJobs');
  if (!cron.validate(schedule)) {
    logger.error(`Invalid recommendedJobs cron expression: ${schedule}`);
    return;
  }
  task = cron.schedule(
    schedule,
    trackedCron('recommendedJobs', async () => {
      if (isRunning) {
        logger.warn('RecommendedJobs: previous tick still running — skipping');
        return;
      }
      isRunning = true;
      const start = Date.now();
      try {
        await checkRecommendedJobsNow();
        logger.info(
          `RecommendedJobs: tick complete in ${Date.now() - start}ms`,
        );
      } finally {
        isRunning = false;
      }
    }),
    { timezone: 'Asia/Kolkata' },
  );
  logger.info(`RecommendedJobs cron scheduled: "${schedule}"`);
};

export const stopRecommendedJobsCron = (): void => {
  if (task) {
    task.stop();
    task = null;
  }
};
