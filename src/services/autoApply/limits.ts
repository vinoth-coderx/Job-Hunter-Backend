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
