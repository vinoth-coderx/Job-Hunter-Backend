import { SubscriptionTier } from '../../types';

/**
 * Daily auto-apply cap by subscription tier. Phase 2 doc references
 * Pro=10/day and Elite=30/day; we map those onto our existing tier
 * scheme (free/weekly/monthly/yearly) until the dedicated Pro/Elite
 * SKUs ship.
 *
 *   monthly → Pro-equivalent → 10/day
 *   yearly  → Elite-equivalent → 30/day
 *   free, weekly → not eligible (return 0)
 */
export const AUTO_APPLY_DAILY_CAP: Record<SubscriptionTier, number> = {
  free: 0,
  weekly: 0,
  monthly: 10,
  yearly: 30,
};

/// Free-trial gives the user the same daily cap as `monthly` for 7 days
/// from activation. Centralised here so the controller, the runner, and
/// the UI all agree on duration + cap.
export const TRIAL_DURATION_DAYS = 7;
export const TRIAL_TIER: SubscriptionTier = 'monthly';

export const isAutoApplyEligible = (tier: SubscriptionTier): boolean =>
  AUTO_APPLY_DAILY_CAP[tier] > 0;

export const cappedDailyLimit = (
  requested: number,
  tier: SubscriptionTier,
): number => {
  const cap = AUTO_APPLY_DAILY_CAP[tier];
  if (cap <= 0) return 0;
  return Math.max(1, Math.min(requested, cap));
};

export interface TrialState {
  /// True while the trial is running — i.e. activated within the last
  /// [TRIAL_DURATION_DAYS] days.
  active: boolean;
  /// When the trial expires. Null when the trial has never been
  /// activated; otherwise always present, even after expiry.
  endsAt: Date | null;
  /// True iff the user has previously activated the trial (consumed or
  /// still running). The trial is one-shot — never re-armed.
  used: boolean;
}

export const computeTrialState = (sub: {
  trialActivatedAt?: Date | null;
  trialUsed?: boolean;
} | undefined | null): TrialState => {
  if (!sub) return { active: false, endsAt: null, used: false };
  const startedAt = sub.trialActivatedAt;
  if (!startedAt) {
    return { active: false, endsAt: null, used: !!sub.trialUsed };
  }
  const endsAt = new Date(
    new Date(startedAt).getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000,
  );
  return {
    active: endsAt.getTime() > Date.now(),
    endsAt,
    used: true,
  };
};

/// Resolves the tier the user actually gets right now — paid tier wins,
/// otherwise an active trial bumps a free user up to [TRIAL_TIER].
export const effectiveTier = (
  rawTier: SubscriptionTier,
  trial: TrialState,
): SubscriptionTier => {
  if (rawTier !== 'free' && rawTier !== 'weekly') return rawTier;
  if (trial.active) return TRIAL_TIER;
  return rawTier;
};
