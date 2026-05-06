"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireSubscription = void 0;
const ApiError_1 = require("../utils/ApiError");
const Subscription_1 = require("../models/Subscription");
const tierRank = {
    free: 0,
    weekly: 1,
    monthly: 2,
    yearly: 3,
};
const requireSubscription = (minTier) => async (req, _res, next) => {
    try {
        if (!req.user)
            throw ApiError_1.ApiError.unauthorized();
        const userTier = req.user.subscription || 'free';
        if (tierRank[userTier] < tierRank[minTier]) {
            throw ApiError_1.ApiError.forbidden(`This feature requires ${minTier} subscription. Upgrade to access.`);
        }
        if (userTier !== 'free') {
            const active = await Subscription_1.Subscription.findOne({
                user: req.user._id,
                status: 'active',
                endDate: { $gt: new Date() },
            }).sort({ endDate: -1 });
            if (!active) {
                throw ApiError_1.ApiError.forbidden('Subscription expired. Please renew.');
            }
        }
        next();
    }
    catch (err) {
        next(err);
    }
};
exports.requireSubscription = requireSubscription;
