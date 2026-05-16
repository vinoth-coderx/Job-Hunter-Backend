import cron, { ScheduledTask } from 'node-cron';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { trackedCron, getCronSchedule } from '../utils/cronTracker';
import { getAppConfig } from '../services/config/config.service';
import { Job } from '../models/Job';
import { AppliedJob } from '../models/AppliedJob';
import { User } from '../models/User';
import { HirerProfile } from '../models/HirerProfile';
import {
  peekCachedSuggestions,
  suggestCandidates,
  type SuggestableCandidate,
} from '../services/ai/candidateSuggester.service';

const cronsEnabled = (): boolean => getAppConfig('CRON_ENABLED') !== 'false';

let task: ScheduledTask | null = null;
let isRunning = false;

// Cap how many jobs we warm per tick. Each job is one Groq call →
// keeping this conservative so a hirer with 30 active jobs doesn't
// burn the global daily quota in one cron run. The morning visit
// still triggers an on-demand call for the rest.
const MAX_JOBS_PER_TICK = 50;

// Same defaults the on-demand /candidate-suggestions endpoint uses.
const POOL_SIZE = 50;
const SUGGEST_LIMIT = 10;

interface ActiveJobRow {
  _id: mongoose.Types.ObjectId;
  hirerProfile: mongoose.Types.ObjectId;
  postedBy: mongoose.Types.ObjectId;
  updatedAt: Date;
}

/**
 * Pre-warm AI candidate suggestions for active hirer jobs so the
 * morning dashboard open serves cached results instead of paying for
 * a fresh ranking. Skips jobs whose cache already covers the current
 * pool — `peekCachedSuggestions` is one Redis read.
 *
 * The cache is keyed by (jobId + jobUpdatedAt + sortedCandidateIds), so
 * a fresh run uses the same key the morning request would derive — we
 * don't accidentally double-pay for the same ranking.
 */
export const runCandidateSuggestionsWarmupNow = async (): Promise<void> => {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const jobs: ActiveJobRow[] = await Job.find({
    isNative: true,
    status: 'active',
    updatedAt: { $gte: since },
  })
    .sort({ updatedAt: -1 })
    .limit(MAX_JOBS_PER_TICK)
    .select('_id hirerProfile postedBy updatedAt')
    .lean<ActiveJobRow[]>();

  let warmed = 0;
  let skippedCached = 0;
  let skippedEmpty = 0;
  let failed = 0;

  for (const j of jobs) {
    try {
      const job = await Job.findById(j._id);
      if (!job) continue;

      // Pool: most-recent applicants from the hirer's other jobs who
      // haven't applied to THIS one yet. Mirrors the on-demand
      // controller's pool definition exactly.
      const existingApplicants = await AppliedJob.distinct('user', {
        job: j._id,
      });
      const candidateRows = await AppliedJob.aggregate<{
        _id: mongoose.Types.ObjectId;
        lastSeenAt: Date;
      }>([
        {
          $match: {
            hirerProfile: j.hirerProfile,
            job: { $ne: j._id },
            status: { $nin: ['rejected', 'withdrawn'] },
            user: { $nin: existingApplicants },
          },
        },
        { $group: { _id: '$user', lastSeenAt: { $max: '$appliedAt' } } },
        { $sort: { lastSeenAt: -1 } },
        { $limit: POOL_SIZE },
      ]);

      if (candidateRows.length === 0) {
        skippedEmpty += 1;
        continue;
      }

      const ids = candidateRows.map((c) => c._id.toString());
      const cached = await peekCachedSuggestions(
        j._id.toString(),
        job.updatedAt,
        ids,
      );
      if (cached) {
        skippedCached += 1;
        continue;
      }

      const users = await User.find({
        _id: { $in: candidateRows.map((c) => c._id) },
      }).select(
        'profile.fullName profile.headline profile.experienceYears profile.skills profile.resumeText profile.avatar',
      );
      const lastSeenMap = new Map<string, Date>(
        candidateRows.map((c) => [c._id.toString(), c.lastSeenAt]),
      );
      const pool: SuggestableCandidate[] = users.map((u) => ({
        userId: u._id.toString(),
        fullName: u.profile?.fullName ?? 'Candidate',
        headline: u.profile?.headline,
        experienceYears: u.profile?.experienceYears,
        skills: u.profile?.skills ?? [],
        resumeText: u.profile?.resumeText,
        lastSeenAt: lastSeenMap.get(u._id.toString())?.toISOString(),
      }));

      // userId attribution = the hirer who posted the job, so usage
      // analytics still attribute the warmed call to a real user.
      await suggestCandidates({
        job,
        pool,
        userId: j.postedBy.toString(),
        limit: SUGGEST_LIMIT,
      });
      warmed += 1;
    } catch (err) {
      failed += 1;
      logger.warn(
        `[candidateWarmup] job=${j._id} failed: ${(err as Error).message}`,
      );
    }
  }

  logger.info(
    `[candidateWarmup] scanned=${jobs.length} warmed=${warmed} skippedCached=${skippedCached} skippedEmpty=${skippedEmpty} failed=${failed}`,
  );

  // Smoke-test that the hirer collection still has rows we'd want to
  // warm tomorrow. Pure read; logged so the admin sees zero-active
  // states without grepping Mongo.
  const totalHirers = await HirerProfile.countDocuments();
  logger.info(`[candidateWarmup] totalHirers=${totalHirers}`);
};

export const startCandidateSuggestionsWarmupCron = (): void => {
  if (!cronsEnabled()) return;
  const schedule = getCronSchedule('candidateSuggestionsWarmup');
  if (!cron.validate(schedule)) {
    logger.error(
      `Invalid candidateSuggestionsWarmup cron expression: ${schedule}`,
    );
    return;
  }
  task = cron.schedule(
    schedule,
    trackedCron('candidateSuggestionsWarmup', async () => {
      if (isRunning) {
        logger.warn(
          'candidateSuggestionsWarmup: previous tick still running — skipping',
        );
        return;
      }
      isRunning = true;
      const start = Date.now();
      try {
        await runCandidateSuggestionsWarmupNow();
        logger.info(
          `candidateSuggestionsWarmup: tick complete in ${Date.now() - start}ms`,
        );
      } finally {
        isRunning = false;
      }
    }),
    { timezone: 'Asia/Kolkata' },
  );
  logger.info(
    `candidateSuggestionsWarmup cron scheduled: "${schedule}"`,
  );
};

export const stopCandidateSuggestionsWarmupCron = (): void => {
  if (task) {
    task.stop();
    task = null;
  }
};
