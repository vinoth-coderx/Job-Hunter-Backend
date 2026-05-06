import { Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { AuthRequest, SubscriptionTier } from '../types';
import { Subscription } from '../models/Subscription';

const tierRank: Record<SubscriptionTier, number> = {
  free: 0,
  weekly: 1,
  monthly: 2,
  yearly: 3,
};

export const requireSubscription =
  (minTier: SubscriptionTier) =>
  async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) throw ApiError.unauthorized();

      const userTier = req.user.subscription || 'free';

      if (tierRank[userTier] < tierRank[minTier]) {
        throw ApiError.forbidden(
          `This feature requires ${minTier} subscription. Upgrade to access.`,
        );
      }

      if (userTier !== 'free') {
        const active = await Subscription.findOne({
          user: req.user._id,
          status: 'active',
          endDate: { $gt: new Date() },
        }).sort({ endDate: -1 });

        if (!active) {
          throw ApiError.forbidden('Subscription expired. Please renew.');
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  };
