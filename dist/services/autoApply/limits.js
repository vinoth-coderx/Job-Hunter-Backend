"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.effectiveTier = exports.computeTrialState = exports.cappedDailyLimit = exports.isAutoApplyEligible = exports.TRIAL_TIER = exports.TRIAL_DURATION_DAYS = exports.AUTO_APPLY_DAILY_CAP = void 0;
exports.AUTO_APPLY_DAILY_CAP = {
    free: 0,
    weekly: 0,
    monthly: 10,
    yearly: 30,
};
exports.TRIAL_DURATION_DAYS = 7;
exports.TRIAL_TIER = 'monthly';
const isAutoApplyEligible = (tier) => exports.AUTO_APPLY_DAILY_CAP[tier] > 0;
exports.isAutoApplyEligible = isAutoApplyEligible;
const cappedDailyLimit = (requested, tier) => {
    const cap = exports.AUTO_APPLY_DAILY_CAP[tier];
    if (cap <= 0)
        return 0;
    return Math.max(1, Math.min(requested, cap));
};
exports.cappedDailyLimit = cappedDailyLimit;
const computeTrialState = (sub) => {
    if (!sub)
        return { active: false, endsAt: null, used: false };
    const startedAt = sub.trialActivatedAt;
    if (!startedAt) {
        return { active: false, endsAt: null, used: !!sub.trialUsed };
    }
    const endsAt = new Date(new Date(startedAt).getTime() + exports.TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
    return {
        active: endsAt.getTime() > Date.now(),
        endsAt,
        used: true,
    };
};
exports.computeTrialState = computeTrialState;
const effectiveTier = (rawTier, trial) => {
    if (rawTier !== 'free' && rawTier !== 'weekly')
        return rawTier;
    if (trial.active)
        return exports.TRIAL_TIER;
    return rawTier;
};
exports.effectiveTier = effectiveTier;
