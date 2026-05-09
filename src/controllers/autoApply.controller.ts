import { Response } from 'express';
import { z } from 'zod';
import { AutoApplySettings, IAutoApplySettings } from '../models/AutoApplySettings';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest, SubscriptionTier } from '../types';
import {
  AUTO_APPLY_DAILY_CAP,
  TRIAL_DURATION_DAYS,
  TrialState,
  cappedDailyLimit,
  computeTrialState,
  effectiveTier,
  isAutoApplyEligible,
} from '../services/autoApply/limits';
import {
  runAutoApplyForUser,
  submitApprovedApplications,
} from '../services/autoApply/runner';
import { AutoApplyLog } from '../models/AutoApplyLog';

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const preferencesSchema = z.object({
  targetRoles: z.array(z.string().min(1).max(100)).max(20).optional(),
  locations: z.array(z.string().min(1).max(100)).max(30).optional(),
  isOpenToRemote: z.boolean().optional(),
  jobTypes: z
    .array(z.enum(['full-time', 'part-time', 'contract', 'internship', 'temporary']))
    .max(5)
    .optional(),
  minSalary: z.coerce.number().min(0).optional(),
  experienceLevels: z.array(z.string().min(1).max(50)).max(10).optional(),
  sources: z.array(z.enum(['native', 'external'])).max(2).optional(),
  companySizes: z.array(z.string().min(1).max(20)).max(10).optional(),
});

const matchingRulesSchema = z.object({
  minMatchPercentage: z.coerce.number().min(50).max(95).optional(),
  minSkillsMatchCount: z.coerce.number().int().min(0).max(10).optional(),
  mustIncludeKeywords: z.array(z.string().min(1).max(50)).max(20).optional(),
  excludeKeywords: z.array(z.string().min(1).max(50)).max(20).optional(),
  blacklistedCompanies: z.array(z.string().min(1).max(100)).max(50).optional(),
  reapplyCooldownDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional(),
});

const aiCoverLetterSchema = z.object({
  enabled: z.boolean().optional(),
  tone: z.enum(['professional', 'friendly', 'technical']).optional(),
  baseTemplate: z.string().max(4000).optional(),
});

export const updateSettingsSchema = z.object({
  body: z.object({
    isEnabled: z.boolean().optional(),
    runTime: z.string().regex(TIME_REGEX, 'Format HH:mm').optional(),
    runDays: z
      .array(
        z.enum([
          'monday',
          'tuesday',
          'wednesday',
          'thursday',
          'friday',
          'saturday',
          'sunday',
        ]),
      )
      .min(1)
      .max(7)
      .optional(),
    dailyLimit: z.coerce.number().int().min(1).max(50).optional(),
    preferences: preferencesSchema.optional(),
    matchingRules: matchingRulesSchema.optional(),
    reviewMode: z.boolean().optional(),
    aiCoverLetter: aiCoverLetterSchema.optional(),
  }),
});

export const pauseSchema = z.object({
  body: z.object({
    days: z.union([z.literal(1), z.literal(3), z.literal(7)]).optional(),
    reason: z.string().max(500).optional(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

interface TierContext {
  /// What the user's account is paying for (free / weekly / monthly /
  /// yearly). Persisted, not affected by the trial.
  rawTier: SubscriptionTier;
  /// What the user gets *right now* — may be bumped to monthly by an
  /// active trial. All gating decisions should use this.
  tier: SubscriptionTier;
  trial: TrialState;
}

const requireTier = async (userId: string): Promise<TierContext> => {
  const user = await User.findById(userId).select('subscription').lean();
  if (!user) throw ApiError.notFound('User not found');
  const rawTier = (user.subscription?.tier ?? 'free') as SubscriptionTier;
  const trial = computeTrialState(user.subscription);
  return { rawTier, tier: effectiveTier(rawTier, trial), trial };
};

/// Idempotently start the auto-apply free trial for users who haven't
/// used it yet. Called from the first GET /settings — that's the moment
/// the user lands on the auto-apply screen, so the timer starts when
/// they actually see the feature, not at signup.
const ensureTrialStarted = async (userId: string): Promise<TierContext> => {
  const ctx = await requireTier(userId);
  if (ctx.rawTier === 'free' && !ctx.trial.used) {
    const now = new Date();
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          'subscription.trialActivatedAt': now,
          'subscription.trialUsed': true,
        },
      },
    );
    return requireTier(userId);
  }
  return ctx;
};

const sanitiseSettings = (
  s: IAutoApplySettings,
  ctx: TierContext,
) => ({
  id: s._id.toString(),
  isEnabled: s.isEnabled,
  isPaused: s.isPaused,
  pauseUntil: s.pauseUntil,
  pauseReason: s.pauseReason,
  runTime: s.runTime,
  runDays: s.runDays,
  dailyLimit: s.dailyLimit,
  preferences: s.preferences,
  matchingRules: s.matchingRules,
  reviewMode: s.reviewMode,
  aiCoverLetter: s.aiCoverLetter,
  totalAutoApplied: s.totalAutoApplied,
  lastRunAt: s.lastRunAt,
  // Plan caps surface to the client so the UI can show ceilings.
  tier: ctx.tier,
  planCap: AUTO_APPLY_DAILY_CAP[ctx.tier],
  eligible: isAutoApplyEligible(ctx.tier),
  trial: {
    active: ctx.trial.active,
    used: ctx.trial.used,
    endsAt: ctx.trial.endsAt,
    durationDays: TRIAL_DURATION_DAYS,
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────

export const getSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  // First settings fetch auto-activates the free trial — that's the
  // moment the user enters the auto-apply flow, so the 7-day timer
  // starts when the feature actually becomes visible to them.
  const ctx = await ensureTrialStarted(req.user.id);

  let settings = await AutoApplySettings.findOne({ user: req.user._id });
  if (!settings) {
    settings = await AutoApplySettings.create({
      user: req.user._id,
      // Start disabled; user opts in.
      isEnabled: false,
      dailyLimit: Math.max(1, AUTO_APPLY_DAILY_CAP[ctx.tier] || 10),
    });
  }

  res.json({ success: true, data: sanitiseSettings(settings, ctx) });
});

export const updateSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const ctx = await requireTier(req.user.id);
  const body = req.body as z.infer<typeof updateSettingsSchema>['body'];

  // Enabling auto-apply requires an eligible tier.
  if (body.isEnabled === true && !isAutoApplyEligible(ctx.tier)) {
    throw ApiError.forbidden(
      'Auto-Apply requires a Monthly or Yearly subscription. Upgrade to enable.',
    );
  }

  let settings = await AutoApplySettings.findOne({ user: req.user._id });
  if (!settings) {
    settings = await AutoApplySettings.create({
      user: req.user._id,
      dailyLimit: Math.max(1, AUTO_APPLY_DAILY_CAP[ctx.tier] || 10),
    });
  }

  if (body.isEnabled !== undefined) settings.isEnabled = body.isEnabled;
  if (body.runTime !== undefined) settings.runTime = body.runTime;
  if (body.runDays !== undefined) settings.runDays = body.runDays;
  if (body.dailyLimit !== undefined) {
    settings.dailyLimit = cappedDailyLimit(body.dailyLimit, ctx.tier);
  }
  if (body.preferences) {
    settings.preferences = {
      ...settings.preferences,
      ...body.preferences,
    };
  }
  if (body.matchingRules) {
    settings.matchingRules = {
      ...settings.matchingRules,
      ...body.matchingRules,
    };
  }
  if (body.reviewMode !== undefined) settings.reviewMode = body.reviewMode;
  if (body.aiCoverLetter) {
    settings.aiCoverLetter = {
      ...settings.aiCoverLetter,
      ...body.aiCoverLetter,
    };
  }

  // Resume from pause when explicitly enabling.
  if (body.isEnabled === true) {
    settings.isPaused = false;
    settings.pauseUntil = undefined;
    settings.pauseReason = undefined;
  }

  await settings.save();
  res.json({ success: true, data: sanitiseSettings(settings, ctx) });
});

export const pauseAutoApply = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const ctx = await requireTier(req.user.id);
  const { days, reason } = req.body as z.infer<typeof pauseSchema>['body'];

  const settings = await AutoApplySettings.findOne({ user: req.user._id });
  if (!settings) throw ApiError.notFound('Auto-apply not configured');

  settings.isPaused = true;
  if (days) {
    settings.pauseUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  } else {
    settings.pauseUntil = undefined; // pause indefinitely until user resumes
  }
  if (reason) settings.pauseReason = reason;

  await settings.save();
  res.json({ success: true, data: sanitiseSettings(settings, ctx) });
});

export const resumeAutoApply = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const ctx = await requireTier(req.user.id);

  const settings = await AutoApplySettings.findOne({ user: req.user._id });
  if (!settings) throw ApiError.notFound('Auto-apply not configured');

  if (!isAutoApplyEligible(ctx.tier)) {
    throw ApiError.forbidden(
      'Auto-Apply requires a Monthly or Yearly subscription.',
    );
  }

  settings.isPaused = false;
  settings.pauseUntil = undefined;
  settings.pauseReason = undefined;
  await settings.save();
  res.json({ success: true, data: sanitiseSettings(settings, ctx) });
});

export const approveSchema = z.object({
  body: z.object({
    logId: z.string().min(1),
    jobIds: z.array(z.string().min(1)).min(1).max(50),
  }),
});

/**
 * Today's review-mode preview. Returns the staged matches from the most
 * recent log that's awaiting approval. The Flutter screen renders these
 * as swipeable cards.
 */
export const getPreview = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const log = await AutoApplyLog.findOne({
    user: req.user._id,
    awaitingApproval: true,
  })
    .sort({ runDate: -1 })
    .populate({
      path: 'appliedJobs.job',
      select: 'title company location skills salaryMin salaryMax remoteType jobType companyLogoUrl status isActive',
    })
    .lean();

  if (!log) {
    res.json({ success: true, data: null });
    return;
  }

  res.json({
    success: true,
    data: {
      logId: log._id.toString(),
      runDate: log.runDate,
      jobsScanned: log.jobsScanned,
      jobsMatched: log.jobsMatched,
      candidates: (log.appliedJobs ?? []).map((a) => {
        // After populate, `a.job` is either a populated object or — for
        // entries whose job was deleted — null. Stay defensive.
        const jobObj = a.job as unknown;
        let jobId = '';
        if (jobObj && typeof jobObj === 'object' && '_id' in jobObj) {
          jobId = String((jobObj as { _id: unknown })._id);
        } else if (jobObj) {
          jobId = String(jobObj);
        }
        return {
          applicationId: null, // not yet applied — review mode
          jobId,
          job: a.job,
          companyName: a.companyName,
          jobTitle: a.jobTitle,
          matchScore: a.matchScore,
          source: a.source,
          status: a.status,
        };
      }),
    },
  });
});

/**
 * Submit user-approved jobs from a review-mode log. Stamps the log
 * `approvalCompletedAt`, swaps stale `pending_review` rows to actual
 * application IDs, and bumps job-level counters.
 */
export const approveJobs = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { logId, jobIds } = req.body as z.infer<typeof approveSchema>['body'];

  const log = await AutoApplyLog.findOne({
    _id: logId,
    user: req.user._id,
    awaitingApproval: true,
  });
  if (!log) throw ApiError.notFound('Review batch not found or already finalised');

  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound('User not found');

  const { applied, failed } = await submitApprovedApplications(user, jobIds);

  // Reflect the submission status into the log entries.
  for (const entry of log.appliedJobs) {
    const jid = entry.job.toString();
    const ok = applied.find((a) => a.job.toString() === jid);
    const fail = failed.find((f) => f.jobId === jid);
    if (ok) {
      entry.application = ok.application;
      entry.appliedAt = ok.appliedAt;
      entry.status = 'applied';
    } else if (fail) {
      entry.status = `failed:${fail.error.slice(0, 80)}`;
    } else if (jobIds.includes(jid)) {
      entry.status = 'failed:unknown';
    } else {
      entry.status = 'skipped';
    }
  }
  log.jobsApplied = applied.length;
  log.awaitingApproval = false;
  log.approvalCompletedAt = new Date();
  await log.save();

  res.json({
    success: true,
    data: {
      applied: applied.length,
      failed: failed.length,
      skipped: log.appliedJobs.length - applied.length - failed.length,
    },
  });
});

export const listLogs = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Math.min(50, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    AutoApplyLog.find({ user: req.user._id })
      .sort({ runDate: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    AutoApplyLog.countDocuments({ user: req.user._id }),
  ]);

  res.json({
    success: true,
    data: items,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
});

export const todaySummary = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const log = await AutoApplyLog.findOne({
    user: req.user._id,
    runDate: { $gte: since },
  })
    .sort({ runDate: -1 })
    .lean();
  res.json({ success: true, data: log });
});

export const runNow = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const ctx = await requireTier(req.user.id);
  if (!isAutoApplyEligible(ctx.tier)) {
    throw ApiError.forbidden('Auto-Apply requires a paid plan');
  }

  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound('User not found');

  const outcome = await runAutoApplyForUser(user, { manual: true });
  if (!outcome) {
    throw ApiError.badRequest(
      'Auto-Apply is disabled or paused; enable it before running.',
    );
  }
  res.json({ success: true, data: outcome });
});
