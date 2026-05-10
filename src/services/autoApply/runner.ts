import mongoose from 'mongoose';
import { AutoApplySettings, IAutoApplySettings } from '../../models/AutoApplySettings';
import { AutoApplyLog, IAutoApplyAppliedEntry, IAutoApplySkippedEntry, SkippedReason } from '../../models/AutoApplyLog';
import { AppliedJob } from '../../models/AppliedJob';
import { Job, IJob } from '../../models/Job';
import { User, IUser } from '../../models/User';
import { Notification } from '../../models/Notification';
import { logger } from '../../utils/logger';
import { scoreForAutoApply } from './scorer';
import {
  computeTrialState,
  effectiveTier,
  isAutoApplyEligible,
} from './limits';
import { SubscriptionTier } from '../../types';
import { generateCoverLetter } from '../ai/coverLetter.service';

export interface RunnerOutcome {
  userId: string;
  ranAt: Date;
  jobsScanned: number;
  jobsMatched: number;
  jobsApplied: number;
  jobsSkipped: number;
  awaitingApproval: boolean;
  logId: string;
}

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

/**
 * Picks candidate jobs for the user, scores each, applies all filters,
 * and either submits applications (auto-send mode) or stages a list of
 * matches awaiting approval (review mode).
 *
 * Idempotency: if a non-manual log already exists for this user today,
 * the runner is a no-op. Manual `run-now` ignores that gate so users can
 * trigger a fresh run on demand.
 */
export const runAutoApplyForUser = async (
  user: IUser,
  options: { manual?: boolean; dryRun?: boolean } = {},
): Promise<RunnerOutcome | null> => {
  const settings = await AutoApplySettings.findOne({ user: user._id });
  if (!settings) return null;

  // Trial users get monthly-tier privileges in the runner too — without
  // this the cron would happily skip them while the controller/UI shows
  // them as eligible, which would be a confusing dead-end.
  const rawTier = (user.subscription?.tier ?? 'free') as SubscriptionTier;
  const tier = effectiveTier(rawTier, computeTrialState(user.subscription));
  if (!isAutoApplyEligible(tier)) return null;
  if (!settings.isEnabled) return null;
  if (
    settings.isPaused &&
    (!settings.pauseUntil || settings.pauseUntil > new Date())
  ) {
    return null;
  }

  // Day gate — one auto-run per UTC day unless manually triggered.
  const today = startOfDay(new Date());
  if (!options.manual) {
    const already = await AutoApplyLog.findOne({
      user: user._id,
      runDate: { $gte: today },
      triggeredManually: false,
    }).select('_id').lean();
    if (already) return null;
  }

  // Resume / profile gate — never auto-apply if the user has no resume.
  if (!user.profile.resumeUrl && !user.profile.resumeFile) {
    logger.info(`[autoApply] skip ${user.email}: no resume on file`);
    return null;
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const reapplyCutoff = new Date(
    Date.now() - settings.matchingRules.reapplyCooldownDays * 24 * 60 * 60 * 1000,
  );

  // Candidate pool — native easy-apply jobs only. External / aggregator
  // listings need a custom form or a third-party site, neither of which
  // we can submit to without a human in the loop. The `sources` setting
  // is ignored on purpose so a stale "external" preference can't drag
  // in jobs we can't safely auto-apply to.
  const baseFilter: Record<string, unknown> = {
    postedAt: { $gte: cutoff },
    isNative: true,
    status: 'active',
  };
  if (settings.preferences.locations?.length) {
    baseFilter.location = {
      $regex: settings.preferences.locations.map(escapeRegex).join('|'),
      $options: 'i',
    };
  }
  if (settings.preferences.jobTypes?.length) {
    baseFilter.jobType = { $in: settings.preferences.jobTypes };
  }
  if (settings.preferences.minSalary) {
    baseFilter.$or = [
      { salaryMin: { $gte: settings.preferences.minSalary } },
      { salaryMax: { $gte: settings.preferences.minSalary } },
    ];
  }

  // Cap pool size — runner has a per-call budget so a noisy day doesn't
  // pin a worker forever.
  const pool = await Job.find(baseFilter).sort({ postedAt: -1 }).limit(500);

  // Pre-fetch jobs the user already applied to within the cooldown window.
  const recentApplications = await AppliedJob.find({
    user: user._id,
    appliedAt: { $gte: reapplyCutoff },
  })
    .select('job hirerProfile jobSnapshot.company')
    .lean();
  const appliedJobIds = new Set(
    recentApplications.map((a) => a.job.toString()),
  );
  const cooldownCompanies = new Set(
    recentApplications.map((a) => (a.jobSnapshot.company || '').toLowerCase()),
  );

  const blacklist = new Set(
    (settings.matchingRules.blacklistedCompanies || []).map((c) => c.toLowerCase()),
  );
  const includeKW = (settings.matchingRules.mustIncludeKeywords || []).map((k) => k.toLowerCase());
  const excludeKW = (settings.matchingRules.excludeKeywords || []).map((k) => k.toLowerCase());

  const ranked: { job: IJob; score: number; matched: number }[] = [];
  const skipped: IAutoApplySkippedEntry[] = [];

  for (const job of pool) {
    if (appliedJobIds.has(job._id.toString())) {
      skipped.push({ job: job._id, reason: 'already_applied' });
      continue;
    }
    const company = (job.company || '').toLowerCase();
    if (blacklist.has(company)) {
      skipped.push({ job: job._id, reason: 'blacklisted' });
      continue;
    }
    if (cooldownCompanies.has(company)) {
      skipped.push({ job: job._id, reason: 'cooldown' });
      continue;
    }
    const blob = `${job.title} ${job.description}`.toLowerCase();
    if (includeKW.length && !includeKW.every((kw) => blob.includes(kw))) {
      skipped.push({ job: job._id, reason: 'keyword_excluded' });
      continue;
    }
    if (excludeKW.some((kw) => blob.includes(kw))) {
      skipped.push({ job: job._id, reason: 'keyword_excluded' });
      continue;
    }

    const score = scoreForAutoApply(user, job);
    if (score.total < settings.matchingRules.minMatchPercentage) {
      skipped.push({ job: job._id, reason: 'below_match', matchScore: score.total });
      continue;
    }
    if (score.matchedSkills.length < settings.matchingRules.minSkillsMatchCount) {
      skipped.push({ job: job._id, reason: 'missing_required_skills', matchScore: score.total });
      continue;
    }
    if (settings.preferences.minSalary) {
      const offered = job.salaryMax ?? job.salaryMin ?? 0;
      if (offered > 0 && offered < settings.preferences.minSalary) {
        skipped.push({ job: job._id, reason: 'salary_below_threshold', matchScore: score.total });
        continue;
      }
    }
    ranked.push({ job, score: score.total, matched: score.matchedSkills.length });
  }

  ranked.sort((a, b) => b.score - a.score || b.matched - a.matched);
  const limit = Math.min(settings.dailyLimit, ranked.length);
  const selected = ranked.slice(0, limit);
  const overflow = ranked.slice(limit);
  for (const o of overflow) {
    skipped.push({ job: o.job._id, reason: 'limit_reached', matchScore: o.score });
  }

  // Either stage for review or submit immediately.
  const applied: IAutoApplyAppliedEntry[] = [];
  // Cover letter is Elite-equivalent — yearly tier only, and the user
  // has to opt in via settings.aiCoverLetter.enabled.
  const coverLetterEnabled =
    settings.aiCoverLetter.enabled && tier === 'yearly';

  // Direct-apply mode (no review). The legacy `settings.reviewMode`
  // field is intentionally ignored — auto-apply now always submits
  // immediately for the easy-apply jobs that survived the filters.
  if (!options.dryRun) {
    for (const cand of selected) {
      try {
        let quickNote: string | undefined;
        if (coverLetterEnabled) {
          try {
            const cl = await generateCoverLetter({
              user,
              job: cand.job,
              tone: settings.aiCoverLetter.tone,
              baseTemplate: settings.aiCoverLetter.baseTemplate,
            });
            quickNote = cl.letter;
          } catch (e) {
            logger.warn(
              `[autoApply] cover-letter failed for ${cand.job._id}: ${(e as Error).message}`,
            );
          }
        }
        const result = await submitNativeApplication(
          user,
          cand.job,
          cand.score,
          { quickNote, coverLetterUsed: !!quickNote },
        );
        applied.push(result);
      } catch (err) {
        logger.warn(`[autoApply] apply failed: ${(err as Error).message}`);
        skipped.push({
          job: cand.job._id,
          reason: 'already_applied',
          matchScore: cand.score,
        });
      }
    }
  }

  const log = await AutoApplyLog.create({
    user: user._id,
    runDate: new Date(),
    jobsScanned: pool.length,
    jobsMatched: ranked.length,
    jobsApplied: applied.length,
    jobsSkipped: skipped.length,
    appliedJobs: applied,
    skippedJobs: skipped,
    awaitingApproval: false,
    notificationSent: false,
    triggeredManually: !!options.manual,
  });

  // Update settings.
  settings.lastRunAt = new Date();
  if (applied.length > 0) {
    settings.totalAutoApplied += applied.length;
  }
  await settings.save();

  // Daily summary in-app notification — only when something actually
  // got applied, since direct-apply mode means a no-op run isn't worth
  // pinging the user about.
  try {
    if (applied.length > 0) {
      await Notification.create({
        user: user._id,
        role: 'seeker',
        type: 'auto_apply_summary',
        title: `Applied to ${applied.length} jobs for you`,
        body: `Best match: ${applied[0]?.jobTitle ?? '—'} @ ${applied[0]?.companyName ?? '—'}`,
        data: { logId: log._id.toString() },
      });
      log.notificationSent = true;
      await log.save();
    }
  } catch {
    // best-effort
  }

  return {
    userId: user._id.toString(),
    ranAt: new Date(),
    jobsScanned: pool.length,
    jobsMatched: ranked.length,
    jobsApplied: applied.length,
    jobsSkipped: skipped.length,
    awaitingApproval: false,
    logId: log._id.toString(),
  };
};

const submitNativeApplication = async (
  user: IUser,
  job: IJob,
  score: number,
  options: { quickNote?: string; coverLetterUsed?: boolean } = {},
): Promise<IAutoApplyAppliedEntry> => {
  // Validate: native + active + still open (deadline, status).
  if (!job.isNative || job.status !== 'active' || !job.isActive) {
    throw new Error('Job not eligible (not native/active)');
  }
  if (job.applicationDeadline && job.applicationDeadline < new Date()) {
    throw new Error('Past deadline');
  }
  // Required screening questions block auto-apply — those need human input.
  if ((job.screeningQuestions ?? []).some((q) => q.isRequired)) {
    throw new Error('Has required screening questions');
  }

  const exists = await AppliedJob.findOne({ user: user._id, job: job._id });
  if (exists) throw new Error('Already applied');

  const application = await AppliedJob.create({
    user: user._id,
    job: job._id,
    hirerProfile: job.hirerProfile,
    jobSnapshot: {
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,
    },
    applyType: 'auto_apply',
    source: 'native',
    resumeUrlSnapshot: user.profile.resumeUrl,
    quickNote: options.quickNote,
    matchScore: score,
    status: 'applied',
    statusHistory: [{ status: 'applied', changedAt: new Date(), changedBy: user._id as mongoose.Types.ObjectId }],
  });

  await Job.updateOne({ _id: job._id }, { $inc: { applicationsCount: 1 } });

  return {
    job: job._id,
    application: application._id,
    companyName: job.company,
    jobTitle: job.title,
    matchScore: score,
    source: 'native',
    appliedAt: new Date(),
    coverLetterUsed: !!options.coverLetterUsed,
    status: 'applied',
  };
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Bridge for review-mode → actually submit user-approved applications.
 * Used by the approve endpoint in Slice 13.
 */
export const submitApprovedApplications = async (
  user: IUser,
  jobIds: string[],
): Promise<{ applied: IAutoApplyAppliedEntry[]; failed: { jobId: string; error: string }[] }> => {
  const applied: IAutoApplyAppliedEntry[] = [];
  const failed: { jobId: string; error: string }[] = [];
  const jobs = await Job.find({ _id: { $in: jobIds } });
  for (const job of jobs) {
    try {
      const score = scoreForAutoApply(user, job).total;
      const entry = await submitNativeApplication(user, job, score);
      applied.push(entry);
    } catch (err) {
      failed.push({ jobId: job._id.toString(), error: (err as Error).message });
    }
  }
  if (applied.length > 0) {
    await AutoApplySettings.updateOne(
      { user: user._id },
      { $inc: { totalAutoApplied: applied.length } },
    );
  }
  return { applied, failed };
};
