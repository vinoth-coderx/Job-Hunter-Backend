import { Response } from 'express';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { Subscription } from '../models/Subscription';
import { User } from '../models/User';
import { SubscriptionTier } from '../types';

const TIERS: SubscriptionTier[] = ['free', 'weekly', 'monthly', 'yearly'];

export const getSubscriptionsOverview = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Tier counts use User.subscription.tier as the source of truth so
    // even free users are tallied. Active-subscriptions tally Subscription
    // collection rows separately because that's the row that represents
    // a paid term.
    const [tierCountsAgg, activeSubscriptions, expiringIn7Days, revenue] =
      await Promise.all([
        User.aggregate<{ _id: SubscriptionTier; count: number }>([
          { $group: { _id: '$subscription.tier', count: { $sum: 1 } } },
        ]),
        Subscription.countDocuments({
          status: 'active',
          endDate: { $gt: now },
        }),
        Subscription.countDocuments({
          status: 'active',
          endDate: { $gt: now, $lte: sevenDaysOut },
        }),
        Subscription.aggregate([
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

    const byTier: Record<SubscriptionTier, number> = {
      free: 0,
      weekly: 0,
      monthly: 0,
      yearly: 0,
    };
    for (const row of tierCountsAgg) {
      if (TIERS.includes(row._id)) byTier[row._id] = row.count;
    }
    const total = byTier.free + byTier.weekly + byTier.monthly + byTier.yearly;

    const facet = revenue[0] as
      | {
          today: { total: number }[];
          thisMonth: { total: number }[];
          allTime: { total: number }[];
        }
      | undefined;

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
  },
);
