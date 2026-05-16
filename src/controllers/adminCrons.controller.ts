import { Response } from 'express';
import cron from 'node-cron';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { KNOWN_CRONS, readCronStatus, getCronSchedule } from '../utils/cronTracker';
import {
  getAppConfig,
  setAppConfig,
} from '../services/config/config.service';
import {
  runSubscriptionCheckNow,
  runAppliedJobsCleanupNow,
  runJobFetchNow,
  startJobScraperCron,
  stopJobScraperCron,
} from '../jobs/jobScraper.cron';
import {
  checkAlertsNow,
  startAlertCheckerCron,
  stopAlertCheckerCron,
} from '../jobs/alertChecker.cron';
import {
  runAutoApplyTickNow,
  startAutoApplyCron,
  stopAutoApplyCron,
} from '../jobs/autoApply.cron';
import {
  runTrustMaintenanceNow,
  startTrustMaintenanceCron,
  stopTrustMaintenanceCron,
} from '../jobs/trustMaintenance.cron';
import {
  runCandidateSuggestionsWarmupNow,
  startCandidateSuggestionsWarmupCron,
  stopCandidateSuggestionsWarmupCron,
} from '../jobs/candidateSuggestionsWarmup.cron';
import {
  runAiCostAlertNow,
  startAiCostAlertCron,
  stopAiCostAlertCron,
} from '../jobs/aiCostAlert.cron';
import { nextRunFromExpression } from '../utils/cronNextRun';

/** Wire each known cron name to the function that runs its body. */
const RUNNERS: Record<string, () => Promise<void>> = {
  subscriptionChecker: runSubscriptionCheckNow,
  appliedJobsCleanup: runAppliedJobsCleanupNow,
  alertChecker: checkAlertsNow,
  autoApply: runAutoApplyTickNow,
  trustMaintenance: runTrustMaintenanceNow,
  candidateSuggestionsWarmup: runCandidateSuggestionsWarmupNow,
  aiCostAlert: runAiCostAlertNow,
  // jobScraper isn't on a node-cron schedule today (admin-triggered only),
  // but we still surface it so the UI can dispatch it manually.
  jobScraper: async () => {
    await runJobFetchNow();
  },
};

const cronsEnabled = (): boolean => getAppConfig('CRON_ENABLED') !== 'false';

/**
 * Stop every cron and start them again — used after a schedule edit or a
 * master-switch flip. Each start* honors `cronsEnabled()` so a stop-only
 * effect is achieved by toggling CRON_ENABLED before calling this.
 */
const restartAllCrons = (): void => {
  stopJobScraperCron();
  stopAlertCheckerCron();
  stopAutoApplyCron();
  stopTrustMaintenanceCron();
  stopCandidateSuggestionsWarmupCron();
  stopAiCostAlertCron();
  if (cronsEnabled()) {
    startJobScraperCron();
    startAlertCheckerCron();
    startAutoApplyCron();
    startTrustMaintenanceCron();
    startCandidateSuggestionsWarmupCron();
    startAiCostAlertCron();
  }
};

export const getCronsOverview = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    const masterEnabled = cronsEnabled();

    const definitions = [
      ...KNOWN_CRONS.map((c) => ({
        name: c.name,
        // Effective schedule: admin override → default. Surfaces the
        // currently-in-use expression so the UI shows truth, not the
        // hardcoded baseline.
        schedule: getCronSchedule(c.name),
        defaultSchedule: c.schedule,
        description: c.description,
      })),
      // jobScraper is dispatched on-demand, not on a node-cron schedule.
      {
        name: 'jobScraper',
        schedule: 'manual',
        defaultSchedule: 'manual',
        description: 'Manual — fetch jobs from every configured source',
      },
    ];

    const jobs = await Promise.all(
      definitions.map(async (d) => {
        const status = await readCronStatus(d.name, d.schedule);
        return {
          name: d.name,
          schedule: d.schedule,
          defaultSchedule: d.defaultSchedule,
          editable: d.schedule !== 'manual',
          enabled: masterEnabled,
          lastRunAt: status.lastRunAt,
          lastDurationMs: status.lastDurationMs,
          lastError: status.lastError,
          nextRunAt:
            d.schedule === 'manual' || !masterEnabled
              ? undefined
              : nextRunFromExpression(d.schedule)?.toISOString(),
        };
      }),
    );

    res.json({ masterEnabled, jobs });
  },
);

export const setCronMaster = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      throw ApiError.badRequest('enabled must be a boolean');
    }
    await setAppConfig({
      key: 'CRON_ENABLED',
      category: 'cron',
      isSecret: false,
      value: enabled ? 'true' : 'false',
      updatedBy: req.user?.id,
    });
    // Apply the flip live — stop everything, then conditionally restart
    // based on the new value. Avoids waiting for a process bounce.
    restartAllCrons();
    res.json({ enabled });
  },
);

export const setCronSchedule = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const name = req.params.name;
    if (typeof name !== 'string' || !name) {
      throw ApiError.badRequest('Cron name required');
    }
    if (!KNOWN_CRONS.some((c) => c.name === name)) {
      throw ApiError.notFound(`Unknown cron "${name}"`);
    }
    const schedule = typeof req.body?.schedule === 'string'
      ? req.body.schedule.trim()
      : '';
    if (!schedule) {
      throw ApiError.badRequest('schedule (cron expression) is required');
    }
    if (!cron.validate(schedule)) {
      throw ApiError.badRequest(
        `Invalid cron expression "${schedule}". Use the 5-field "min hr dom mon dow" syntax.`,
      );
    }
    await setAppConfig({
      key: `CRON_SCHEDULE_${name}`,
      category: 'cron',
      isSecret: false,
      value: schedule,
      updatedBy: req.user?.id,
    });
    // Restart so the new expression takes effect immediately. Cheap op —
    // node-cron stops/starts in <1ms each.
    restartAllCrons();
    res.json({
      name,
      schedule,
      nextRunAt: nextRunFromExpression(schedule)?.toISOString(),
    });
  },
);

export const runCronNow = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const name = req.params.name;
    if (typeof name !== 'string' || !name) throw ApiError.badRequest('Cron name required');
    const runner = RUNNERS[name];
    if (!runner) throw ApiError.notFound(`Unknown cron "${name}"`);

    const startedAt = new Date().toISOString();

    // Fire-and-forget so the HTTP request doesn't block on a long scrape.
    // Tracking is handled by trackedCron inside the runner.
    void runner().catch(() => {
      // The runner itself already logs + records via cronTracker.
    });

    res.json({ ok: true, startedAt });
  },
);
