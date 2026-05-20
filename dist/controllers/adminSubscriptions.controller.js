"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSubscriptionsOverview = void 0;
const asyncHandler_1 = require("../utils/asyncHandler");
const Subscription_1 = require("../models/Subscription");
const User_1 = require("../models/User");
const TIERS = ['free', 'weekly', 'monthly', 'yearly'];
exports.getSubscriptionsOverview = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [tierCountsAgg, activeSubscriptions, expiringIn7Days, revenue] = await Promise.all([
        User_1.User.aggregate([
            { $group: { _id: '$subscription.tier', count: { $sum: 1 } } },
        ]),
        Subscription_1.Subscription.countDocuments({
            status: 'active',
            endDate: { $gt: now },
        }),
        Subscription_1.Subscription.countDocuments({
            status: 'active',
            endDate: { $gt: now, $lte: sevenDaysOut },
        }),
        Subscription_1.Subscription.aggregate([
            {
                $facet: {
                    today: [
                        {
                            $match: {
                                status: { $in: ['active', 'expired', 'cancelled'] },
                                createdAt: { $gte: startOfDay },
                            },
                        },
                        { $group: { _id: null, total: { $sum: '$amountPaid' } } },
                    ],
                    thisMonth: [
                        {
                            $match: {
                                status: { $in: ['active', 'expired', 'cancelled'] },
                                createdAt: { $gte: startOfMonth },
                            },
                        },
                        { $group: { _id: null, total: { $sum: '$amountPaid' } } },
                    ],
                    allTime: [
                        {
                            $match: {
                                status: { $in: ['active', 'expired', 'cancelled'] },
                            },
                        },
                        { $group: { _id: null, total: { $sum: '$amountPaid' } } },
                    ],
                },
            },
        ]),
    ]);
    const byTier = {
        free: 0,
        weekly: 0,
        monthly: 0,
        yearly: 0,
    };
    for (const row of tierCountsAgg) {
        if (TIERS.includes(row._id))
            byTier[row._id] = row.count;
    }
    const total = byTier.free + byTier.weekly + byTier.monthly + byTier.yearly;
    const facet = revenue[0];
    res.json({
        total,
        byTier,
        revenueInr: {
            today: facet?.today[0]?.total ?? 0,
            thisMonth: facet?.thisMonth[0]?.total ?? 0,
            allTime: facet?.allTime[0]?.total ?? 0,
        },
        activeSubscriptions,
        expiringIn7Days,
    });
});
