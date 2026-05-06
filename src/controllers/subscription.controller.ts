import { Response } from 'express';
import { z } from 'zod';
import { Subscription, SUBSCRIPTION_PLANS } from '../models/Subscription';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest, SubscriptionTier } from '../types';
import { logger } from '../utils/logger';

export const subscribeSchema = z.object({
  body: z.object({
    tier: z.enum(['free', 'weekly', 'monthly', 'yearly']),
    paymentMethod: z.enum(['razorpay', 'stripe', 'manual']).optional(),
    paymentId: z.string().optional(),
    orderId: z.string().optional(),
  }),
});

export const listPlans = asyncHandler(async (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: Object.values(SUBSCRIPTION_PLANS) });
});

export const currentSubscription = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const active = await Subscription.findOne({
    user: req.user._id,
    status: 'active',
    endDate: { $gt: new Date() },
  }).sort({ endDate: -1 });

  const user = await User.findById(req.user._id);
  res.json({
    success: true,
    data: {
      tier: user?.subscription.tier || 'free',
      status: user?.subscription.status || 'active',
      activeSubscription: active,
      plan: SUBSCRIPTION_PLANS[user?.subscription.tier || 'free'],
    },
  });
});

export const subscribe = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { tier, paymentMethod, paymentId, orderId } = req.body as {
    tier: SubscriptionTier;
    paymentMethod?: 'razorpay' | 'stripe' | 'manual';
    paymentId?: string;
    orderId?: string;
  };

  const plan = SUBSCRIPTION_PLANS[tier];
  if (!plan) throw ApiError.badRequest('Invalid subscription tier');

  if (tier !== 'free' && !paymentId) {
    throw ApiError.badRequest('Payment ID required for paid tiers');
  }

  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  await Subscription.updateMany(
    { user: req.user._id, status: 'active' },
    { $set: { status: 'cancelled', cancelledAt: new Date() } },
  );

  const sub = await Subscription.create({
    user: req.user._id,
    tier,
    status: 'active',
    startDate,
    endDate,
    amountPaid: plan.priceInr,
    currency: 'INR',
    paymentMethod,
    paymentId,
    orderId,
    autoRenew: tier !== 'free',
  });

  await User.findByIdAndUpdate(req.user._id, {
    $set: {
      'subscription.tier': tier,
      'subscription.status': 'active',
      'subscription.startDate': startDate,
      'subscription.endDate': endDate,
      'subscription.paymentId': paymentId,
    },
  });

  logger.info(`User ${req.user.email} subscribed to ${tier}`);
  res.status(201).json({ success: true, message: 'Subscription activated', data: sub });
});

export const cancelSubscription = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const sub = await Subscription.findOneAndUpdate(
    { user: req.user._id, status: 'active' },
    { $set: { status: 'cancelled', cancelledAt: new Date(), autoRenew: false } },
    { new: true },
  );

  if (!sub) throw ApiError.notFound('No active subscription');

  await User.findByIdAndUpdate(req.user._id, {
    $set: { 'subscription.tier': 'free', 'subscription.status': 'cancelled' },
  });

  res.json({ success: true, message: 'Subscription cancelled', data: sub });
});

export const subscriptionHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const subs = await Subscription.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: subs });
});
