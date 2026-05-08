import { Request, Response } from 'express';
import { z } from 'zod';
import { Subscription, SUBSCRIPTION_PLANS } from '../models/Subscription';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest, SubscriptionTier } from '../types';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import {
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../services/razorpay.service';

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

// ─────────────────────────────────────────────────────────────────────────
// Razorpay
// ─────────────────────────────────────────────────────────────────────────

export const createRazorpayOrderSchema = z.object({
  body: z.object({
    tier: z.enum(['weekly', 'monthly', 'yearly']),
  }),
});

export const verifyRazorpayPaymentSchema = z.object({
  body: z.object({
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
    tier: z.enum(['weekly', 'monthly', 'yearly']),
  }),
});

/**
 * Create a Razorpay order pinned to a tier. The amount is taken from
 * SUBSCRIPTION_PLANS server-side — never from the client — so a
 * tampered request can't pay ₹1 for the yearly plan.
 */
export const razorpayCreateOrder = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { tier } = req.body as { tier: SubscriptionTier };
  const plan = SUBSCRIPTION_PLANS[tier];
  if (!plan || plan.priceInr <= 0) throw ApiError.badRequest('Invalid paid tier');

  const order = await createRazorpayOrder({
    amountPaise: plan.priceInr * 100,
    currency: 'INR',
    receipt: `sub_${req.user.id}_${Date.now()}`,
    notes: {
      userId: req.user.id,
      tier,
    },
  });

  res.status(201).json({
    success: true,
    data: {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: env.RAZORPAY_KEY_ID,
      tier,
      planName: plan.name,
    },
  });
});

/**
 * Verify a Razorpay payment + activate the subscription on success.
 * Signature mismatch returns 400 — we never write a sub for unverified
 * payments. Idempotent: if the same payment_id is submitted twice, the
 * second call returns the existing active subscription instead of
 * double-billing.
 */
export const razorpayVerifyPayment = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    tier,
  } = req.body as {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
    tier: SubscriptionTier;
  };

  const ok = verifyPaymentSignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });
  if (!ok) {
    logger.warn(`Razorpay signature mismatch for user ${req.user.id} order ${razorpay_order_id}`);
    throw ApiError.badRequest('Payment signature verification failed');
  }

  // Idempotency — same paymentId already activated.
  const existing = await Subscription.findOne({
    user: req.user._id,
    paymentId: razorpay_payment_id,
  });
  if (existing) {
    res.json({ success: true, message: 'Already activated', data: existing });
    return;
  }

  const plan = SUBSCRIPTION_PLANS[tier];
  if (!plan) throw ApiError.badRequest('Invalid tier');

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
    paymentMethod: 'razorpay',
    paymentId: razorpay_payment_id,
    orderId: razorpay_order_id,
    autoRenew: false,
  });

  await User.findByIdAndUpdate(req.user._id, {
    $set: {
      'subscription.tier': tier,
      'subscription.status': 'active',
      'subscription.startDate': startDate,
      'subscription.endDate': endDate,
      'subscription.paymentId': razorpay_payment_id,
    },
  });

  logger.info(`Razorpay payment verified: user=${req.user.email} tier=${tier} payment=${razorpay_payment_id}`);
  res.status(201).json({ success: true, data: sub });
});

/**
 * Webhook for renewal / payment.failed / refund events.
 * Mounted on a route that uses `express.raw({ type: 'application/json' })`
 * so we can verify the signature against the exact bytes Razorpay sent.
 */
export const razorpayWebhook = asyncHandler(async (req: Request, res: Response) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('RAZORPAY_WEBHOOK_SECRET not set; rejecting webhook');
    throw ApiError.internal('Webhook not configured');
  }

  const signature = req.headers['x-razorpay-signature'];
  if (typeof signature !== 'string') {
    throw ApiError.badRequest('Missing x-razorpay-signature header');
  }

  // `req.body` is a Buffer here (raw body parser).
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
  const ok = verifyWebhookSignature({
    rawBody,
    signature,
    webhookSecret: secret,
  });
  if (!ok) {
    logger.warn('Razorpay webhook signature mismatch');
    throw ApiError.badRequest('Invalid signature');
  }

  let payload: { event?: string; payload?: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw ApiError.badRequest('Invalid JSON payload');
  }

  // We log the event for now; auto-renew handling is a Phase 2 enhancement
  // (requires a Razorpay Subscriptions plan, not just one-shot orders).
  logger.info(`Razorpay webhook received: ${payload.event}`);

  res.json({ success: true });
});
