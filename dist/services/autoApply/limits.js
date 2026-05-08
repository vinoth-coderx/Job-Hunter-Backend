"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cappedDailyLimit = exports.isAutoApplyEligible = exports.AUTO_APPLY_DAILY_CAP = void 0;
exports.AUTO_APPLY_DAILY_CAP = {
    free: 0,
    weekly: 0,
    monthly: 10,
    yearly: 30,
};
const isAutoApplyEligible = (tier) => exports.AUTO_APPLY_DAILY_CAP[tier] > 0;
exports.isAutoApplyEligible = isAutoApplyEligible;
const cappedDailyLimit = (requested, tier) => {
    const cap = exports.AUTO_APPLY_DAILY_CAP[tier];
    if (cap <= 0)
        return 0;
    return Math.max(1, Math.min(requested, cap));
};
exports.cappedDailyLimit = cappedDailyLimit;
