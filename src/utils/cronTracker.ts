import { redis } from '../config/redis';
import { logger } from './logger';

/**
 * Lightweight observability for `node-cron` jobs. Each tracked run
 * writes a single Redis hash `cron:<name>` capturing the most recent
 * outcome — `lastStatus`, `lastRunAt`, `lastDurationMs`, and (on
 * failure) `lastError`. The admin Health page reads these to surface
 * which crons are alive and which haven't fired in a while.
 *
 * Intentionally minimal: no history, no metrics aggregation. The goal
 * is "did the cron run, and did it succeed?" at a glance.
 */
export type CronRunStatus = 'running' | 'success' | 'failed';

export interface CronStatus {
  name: string;
  schedule?: string;
  lastStatus?: CronRunStatus;
  lastRunAt?: string;
  lastDurationMs?: number;
  lastError?: string;
  runCount: number;
  failureCount: number;
}

const key = (name: string): string => `cron:${name}`;

const recordCronRun = async (
  name: string,
  status: CronRunStatus,
  meta?: { durationMs?: number; error?: string },
): Promise<void> => {
  const payload: Record<string, string> = {
    lastStatus: status,
    lastRunAt: new Date().toISOString(),
  };
  if (meta?.durationMs !== undefined) {
    payload.lastDurationMs = meta.durationMs.toString();
  }
  if (meta?.error) {
    payload.lastError = meta.error.slice(0, 500);
  }
  try {
    await redis.hset(key(name), payload);
    if (status === 'success') {
      await redis.hincrby(key(name), 'runCount', 1);
    } else if (status === 'failed') {
      await redis.hincrby(key(name), 'failureCount', 1);
    }
  } catch (err) {
    // Cron tracking failure must never crash the cron — the user-visible
    // job is the actual cron, this is just observability.
    logger.warn(`cronTracker write failed for ${name}: ${err}`);
  }
};

/**
 * Wraps a cron callback with tracking. Use as:
 *
 *     cron.schedule('0 * * * *', trackedCron('myJob', async () => { ... }))
 *
 * On entry we mark `running`; on resolution `success` with duration; on
 * throw `failed` with the error message logged via [logger.error]. The
 * wrapper does NOT re-throw — node-cron treats unhandled rejections
 * inconsistently across versions, and the project convention up to now
 * has been "log + swallow" inside each cron so one failure doesn't
 * silently dismantle the schedule.
 */
export const trackedCron = (
  name: string,
  fn: () => Promise<void>,
): (() => Promise<void>) => {
  return async () => {
    const started = Date.now();
    await recordCronRun(name, 'running');
    try {
      await fn();
      await recordCronRun(name, 'success', {
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error(`Cron "${name}" failed: ${message}`, err);
      await recordCronRun(name, 'failed', {
        durationMs: Date.now() - started,
        error: message,
      });
    }
  };
};

export const readCronStatus = async (
  name: string,
  schedule?: string,
): Promise<CronStatus> => {
  try {
    const raw = await redis.hgetall(key(name));
    return {
      name,
      schedule,
      lastStatus: (raw.lastStatus as CronRunStatus | undefined) || undefined,
      lastRunAt: raw.lastRunAt || undefined,
      lastDurationMs: raw.lastDurationMs
        ? parseInt(raw.lastDurationMs, 10)
        : undefined,
      lastError: raw.lastError || undefined,
      runCount: raw.runCount ? parseInt(raw.runCount, 10) : 0,
      failureCount: raw.failureCount ? parseInt(raw.failureCount, 10) : 0,
    };
  } catch (err) {
    logger.warn(`cronTracker read failed for ${name}: ${err}`);
    return { name, schedule, runCount: 0, failureCount: 0 };
  }
};

/**
 * Names of every cron the backend registers. Kept in one place so the
 * admin Health endpoint can list them without each cron file having to
 * register itself separately. The `schedule` field is the *code-side
 * default*; the effective schedule at runtime is the admin override
 * stored at `CRON_SCHEDULE_<name>` in AppConfig (read via
 * `getCronSchedule`), falling back to this default when no override is set.
 */
export const KNOWN_CRONS: Array<{ name: string; schedule: string; description: string }> = [
  {
    name: 'subscriptionChecker',
    schedule: '0 0 * * *',
    description: 'Daily — expire stale subscriptions',
  },
  {
    name: 'appliedJobsCleanup',
    schedule: '0 2 * * *',
    description: 'Daily 02:00 IST — purge applied-job records older than 90 days',
  },
  {
    name: 'alertChecker',
    schedule: '*/15 * * * *',
    description: 'Every 15 min — match new jobs against user alerts',
  },
  {
    name: 'recommendedJobs',
    schedule: '*/30 * * * *',
    description:
      'Every 30 min — system-generated push for high-match (>=70%) new jobs to every active seeker, independent of saved alerts',
  },
  {
    name: 'autoApply',
    schedule: '*/15 * * * *',
    description: 'Every 15 min — sweep users due for auto-apply (Asia/Kolkata)',
  },
  {
    name: 'trustMaintenance',
    schedule: '15 3 * * *',
    description:
      'Daily 03:15 IST — recompute hirer trust scores + sweep inactive sessions',
  },
  {
    name: 'candidateSuggestionsWarmup',
    schedule: '30 4 * * *',
    description:
      'Daily 04:30 IST — pre-warm AI candidate suggestions for active hirer jobs so the morning open is fast and free of fresh quota',
  },
  {
    name: 'aiCostAlert',
    schedule: '0 9 * * *',
    description:
      'Daily 09:00 IST — email admins when 30-day AI spend projection crosses AI_COST_ALERT_USD_30D',
  },
];

/**
 * Build a quick lookup of the code-side default for each known cron so
 * `getCronSchedule` doesn't have to scan KNOWN_CRONS on every cron boot.
 */
const DEFAULT_SCHEDULES: Record<string, string> = KNOWN_CRONS.reduce(
  (acc, c) => {
    acc[c.name] = c.schedule;
    return acc;
  },
  {} as Record<string, string>,
);

/**
 * Returns the effective cron expression for a known cron — the admin
 * override from AppConfig if present, otherwise the hardcoded default.
 * Imports `getAppConfig` lazily so this file stays import-cycle-safe
 * (config.service imports nothing from utils).
 */
export const getCronSchedule = (name: string): string => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAppConfig } = require('../services/config/config.service') as {
    getAppConfig: (key: string) => string | null;
  };
  const override = getAppConfig(`CRON_SCHEDULE_${name}`);
  return override && override.trim().length > 0
    ? override.trim()
    : DEFAULT_SCHEDULES[name] ?? '';
};
