import cron, { ScheduledTask } from 'node-cron';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { ALERT_PUSH_MAX_PER_RUN, CRON_ALERT_SCHEDULE } from '../config/constants';
import { logger } from '../utils/logger';
import { Alert, IAlert } from '../models/Alert';
import { DeviceToken } from '../models/DeviceToken';
import { Job, IJob } from '../models/Job';
import { User } from '../models/User';
import { sendToTokens } from '../services/notification/fcm.service';
import { sendJobAlertEmail } from '../services/notification/email.service';
import { sendJobAlertWhatsApp } from '../services/notification/whatsapp.service';

let alertTask: ScheduledTask | null = null;
let isRunning = false;

const buildJobFilter = (alert: IAlert, since: Date): Record<string, unknown> => {
  const filter: Record<string, unknown> = {
    isActive: true,
    postedAt: { $gt: since },
  };
  if (alert.query && alert.query.trim().length > 0) {
    filter.$text = { $search: alert.query };
  }
  if (alert.location && alert.location.trim().length > 0) {
    filter.location = { $regex: alert.location, $options: 'i' };
  }
  // Filters from the search UI map to either jobType, remoteType, or skills.
  const jobTypes = new Set(['full-time', 'part-time', 'contract', 'internship']);
  const remoteTypes = new Set(['remote', 'hybrid', 'onsite', 'on-site']);
  const skills: string[] = [];
  let jobType: string | undefined;
  let remoteType: string | undefined;
  for (const f of alert.filters) {
    const lc = f.toLowerCase();
    if (jobTypes.has(lc)) jobType = lc;
    else if (remoteTypes.has(lc)) remoteType = lc.replace('on-site', 'onsite');
    else skills.push(lc);
  }
  if (jobType) filter.jobType = jobType;
  if (remoteType) filter.remoteType = remoteType;
  if (skills.length > 0) filter.skills = { $in: skills };
  return filter;
};

interface JobLite {
  _id: Types.ObjectId;
  title: string;
  company: string;
  location: string;
  url: string;
  postedAt?: Date;
}

/**
 * For each active alert, find jobs posted since `lastNotifiedAt` (or the
 * alert's createdAt for first run). Push the most recent N to all of the
 * user's device tokens, then advance `lastNotifiedAt` to the newest job's
 * timestamp so the next tick only sees newer jobs.
 *
 * Safe to call repeatedly — the cursor advances per-alert and dead tokens
 * are cleaned up from the response.
 */
export const checkAlertsNow = async (): Promise<void> => {
  const alerts = await Alert.find({ active: true });
  for (const alert of alerts) {
    try {
      const since = alert.lastNotifiedAt ?? alert.createdAt;
      const filter = buildJobFilter(alert, since);
      const jobs = await Job.find(filter)
        .sort({ postedAt: -1 })
        .limit(ALERT_PUSH_MAX_PER_RUN)
        .select('_id title company location url postedAt')
        .lean<JobLite[]>();

      if (jobs.length === 0) continue;

      // Load the user's preferences + contact info once so we can fan
      // out to whichever channels they enabled.
      const user = await User.findById(alert.user)
        .select('email profile.fullName profile.phone notificationPreferences')
        .lean();
      if (!user) continue;
      const prefs = user.notificationPreferences ?? {
        push: true,
        email: true,
        whatsapp: false,
        jobAlerts: true,
      };
      // Hard global gate — even if push/email are on, skip everything
      // when the user disabled job alerts.
      if (prefs.jobAlerts === false) continue;

      const newest = jobs[0];
      const headline = jobs.length === 1
        ? `${newest.title} at ${newest.company}`
        : `${newest.title} +${jobs.length - 1} more`;

      // ── Push (FCM) — same as before, gated on prefs.push.
      let result: { invalidTokens?: string[] } = {};
      if (prefs.push !== false) {
        const tokens = await DeviceToken.find({ user: alert.user }).select(
          'token',
        );
        const tokenStrs = tokens.map((t) => t.token);
        result = await sendToTokens(tokenStrs, {
          title: alert.label && alert.label.length > 0
            ? `New for "${alert.label}"`
            : 'New job match',
          body: headline,
          data: {
            alertId: alert._id.toString(),
            jobId: newest._id.toString(),
          },
        });
      }

      // ── Email (SMTP via nodemailer)
      if (prefs.email !== false && user.email) {
        try {
          await sendJobAlertEmail({
            toEmail: user.email,
            fullName: user.profile?.fullName ?? 'there',
            alertName: alert.label,
            jobs: jobs as unknown as IJob[],
          });
        } catch (e) {
          logger.warn(`alert email send failed: ${(e as Error).message}`);
        }
      }

      // ── WhatsApp (MSG91) — opt-in.
      if (prefs.whatsapp === true && user.profile?.phone) {
        try {
          await sendJobAlertWhatsApp({
            fullName: user.profile?.fullName ?? 'there',
            phone: user.profile.phone,
            jobs: jobs as unknown as IJob[],
          });
        } catch (e) {
          logger.warn(`alert WhatsApp send failed: ${(e as Error).message}`);
        }
      }

      // Always advance the cursor so we don't re-notify the same jobs even
      // when the FCM SDK isn't configured. The inbox in-app still surfaces
      // matches via GET /alerts.
      alert.lastNotifiedAt = newest.postedAt ?? new Date();
      alert.notificationCount += jobs.length;
      await alert.save();

      // Prune dead device tokens reported by FCM.
      if (result.invalidTokens && result.invalidTokens.length > 0) {
        await DeviceToken.deleteMany({ token: { $in: result.invalidTokens } });
        logger.info(`Alerts: pruned ${result.invalidTokens.length} dead tokens`);
      }
    } catch (err) {
      logger.error(`Alerts: check failed for alert ${alert._id}`, err);
    }
  }
};

export const startAlertCheckerCron = (): void => {
  if (!env.CRON_ENABLED) return;
  if (!cron.validate(CRON_ALERT_SCHEDULE)) {
    logger.error(`Invalid alert cron expression: ${CRON_ALERT_SCHEDULE}`);
    return;
  }
  alertTask = cron.schedule(
    CRON_ALERT_SCHEDULE,
    async () => {
      if (isRunning) {
        logger.warn('Alerts: previous tick still running — skipping');
        return;
      }
      isRunning = true;
      const start = Date.now();
      try {
        await checkAlertsNow();
        logger.info(`Alerts: tick complete in ${Date.now() - start}ms`);
      } catch (err) {
        logger.error('Alerts: cron tick failed', err);
      } finally {
        isRunning = false;
      }
    },
    { timezone: 'Asia/Kolkata' },
  );
  logger.info(`Alerts cron scheduled: "${CRON_ALERT_SCHEDULE}"`);
};

export const stopAlertCheckerCron = (): void => {
  if (alertTask) {
    alertTask.stop();
    alertTask = null;
  }
};
