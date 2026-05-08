import cron, { ScheduledTask } from 'node-cron';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { AutoApplySettings } from '../models/AutoApplySettings';
import { User } from '../models/User';
import { runAutoApplyForUser } from '../services/autoApply/runner';

let task: ScheduledTask | null = null;
let isRunning = false;

const dayKeys = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const istNow = (): { day: typeof dayKeys[number]; hh: string; mm: string } => {
  // Convert UTC → Asia/Kolkata. We don't pull a tz library; the offset is
  // a fixed +05:30 so adding the offset directly is fine.
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  return {
    day: dayKeys[ist.getUTCDay()],
    hh,
    mm,
  };
};

/**
 * Selects users whose `runTime` falls within the [now-7min, now+7min]
 * window so a 15-minute cron tick covers everyone exactly once per day,
 * resilient to slight clock drift.
 */
const isInRunWindow = (runTime: string, hh: string, mm: string): boolean => {
  const [rh, rm] = runTime.split(':').map((s) => parseInt(s, 10));
  if (Number.isNaN(rh) || Number.isNaN(rm)) return false;
  const nowMins = parseInt(hh, 10) * 60 + parseInt(mm, 10);
  const targetMins = rh * 60 + rm;
  let diff = nowMins - targetMins;
  // Wrap across midnight.
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;
  return Math.abs(diff) <= 7;
};

export const runAutoApplyTickNow = async (): Promise<void> => {
  const now = istNow();

  // Find every active settings doc for the current weekday in the time
  // window. Hand to the runner one user at a time — keeps DB load bounded
  // and lets us recover from a single user's failure.
  const candidates = await AutoApplySettings.find({
    isEnabled: true,
    runDays: now.day,
  })
    .select('user runTime isPaused pauseUntil')
    .lean();

  const eligible = candidates.filter((c) => {
    if (!isInRunWindow(c.runTime, now.hh, now.mm)) return false;
    if (c.isPaused) {
      if (!c.pauseUntil) return false;
      if (new Date(c.pauseUntil) > new Date()) return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    logger.debug(
      `[autoApply] no eligible users at ${now.hh}:${now.mm} ${now.day}`,
    );
    return;
  }

  logger.info(
    `[autoApply] tick ${now.hh}:${now.mm} ${now.day} — ${eligible.length} users`,
  );

  for (const c of eligible) {
    try {
      const user = await User.findById(c.user);
      if (!user) continue;
      const out = await runAutoApplyForUser(user);
      if (out) {
        logger.info(
          `[autoApply] ${user.email}: scanned=${out.jobsScanned} matched=${out.jobsMatched} applied=${out.jobsApplied} skipped=${out.jobsSkipped}`,
        );
      }
    } catch (err) {
      logger.error(`[autoApply] user ${c.user} failed: ${(err as Error).message}`);
    }
  }
};

export const startAutoApplyCron = (): void => {
  if (!env.CRON_ENABLED) return;
  // Every 15 minutes — combined with a ±7-minute window in the runner this
  // hits every user exactly once per day, even if a tick fires a minute
  // late.
  const expr = '*/15 * * * *';
  if (!cron.validate(expr)) {
    logger.error(`Invalid auto-apply cron: ${expr}`);
    return;
  }
  task = cron.schedule(
    expr,
    async () => {
      if (isRunning) {
        logger.warn('[autoApply] previous tick still running — skipping');
        return;
      }
      isRunning = true;
      const start = Date.now();
      try {
        await runAutoApplyTickNow();
        logger.info(`[autoApply] tick complete in ${Date.now() - start}ms`);
      } catch (err) {
        logger.error('[autoApply] tick failed', err);
      } finally {
        isRunning = false;
      }
    },
    { timezone: 'Asia/Kolkata' },
  );
  logger.info(`Auto-Apply cron scheduled: "${expr}" (Asia/Kolkata)`);
};

export const stopAutoApplyCron = (): void => {
  if (task) {
    task.stop();
    task = null;
  }
};
