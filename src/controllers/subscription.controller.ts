import { Request, Response } from 'express';
import { z } from 'zod';
import { Subscription, SUBSCRIPTION_PLANS } from '../models/Subscription';
import { User } from '../models/User';
import { WebhookEvent } from '../models/WebhookEvent';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest, SubscriptionTier } from '../types';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import {
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchRazorpayOrder,
  fetchRazorpayPayment,
  resolveRazorpayMode,
  getRazorpayKeyId,
  RazorpayMode,
} from '../services/razorpay.service';

/**
 * Idempotently activate a subscription for a captured Razorpay payment.
 * Trusted inputs only: `userId` and `tier` come from the order's server-set
 * `notes` (Razorpay-fetched), never from the client. `amountPaise` comes
 * from the order's `amount` field (also Razorpay-authoritative).
 *
 * Returns the activated (or pre-existing) Subscription. Safe to call from
 * both `/verify` (client-driven) and the webhook (Razorpay-driven) — the
 * `paymentId` lookup makes the operation idempotent across both paths.
 */
const activateSubscriptionAfterPayment = async (params: {
  userId: string;
  tier: SubscriptionTier;
  paymentId: string;
  orderId: string;
  amountPaise: number;
}) => {
  const { userId, tier, paymentId, orderId, amountPaise } = params;

  const plan = SUBSCRIPTION_PLANS[tier];
  if (!plan || plan.priceInr <= 0) {
    throw ApiError.badRequest(`Invalid paid tier: ${tier}`);
  }
  // Defense in depth: amount in the order must match what the plan currently
  // costs server-side. Catches a stale or tampered order.
  if (amountPaise !== plan.priceInr * 100) {
    logger.warn(
      `Amount mismatch for order ${orderId}: paid ${amountPaise} paise, plan expects ${plan.priceInr * 100}`,
    );
    throw ApiError.badRequest('Order amount does not match plan price');
  }

  // Idempotency — same paymentId already activated. The unique index on
  // paymentId is the hard guarantee; this lookup is the fast path that
  // avoids running the cancel-then-create transaction when we know the
  // record already exists (e.g. webhook arrives after /verify finished).
  const existing = await Subscription.findOne({ paymentId });
  if (existing) return existing;

  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  await Subscription.updateMany(
    { user: userId, status: 'active' },
    { $set: { status: 'cancelled', cancelledAt: new Date() } },
  );

  try {
    const sub = await new Subscription({
      user: userId,
      tier,
      status: 'active',
      startDate,
      endDate,
      amountPaid: plan.priceInr,
      currency: 'INR',
      paymentMethod: 'razorpay',
      paymentId,
      orderId,
      autoRenew: false,
    }).save();
    await User.findByIdAndUpdate(userId, {
      $set: {
        'subscription.tier': tier,
        'subscription.status': 'active',
        'subscription.startDate': startDate,
        'subscription.endDate': endDate,
        'subscription.paymentId': paymentId,
      },
    });
    logger.info(`Subscription activated: user=${userId} tier=${tier} payment=${paymentId}`);
    return sub;
  } catch (err: unknown) {
    // Concurrent /verify + webhook race lost — the other call won the
    // unique-index check. Return the record they created.
    const isDup =
      typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000;
    if (!isDup) throw err;
    const winner = await Subscription.findOne({ paymentId });
    if (!winner) throw err;
    return winner;
  }
};

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
    // Client may request 'test' mode (debug builds, emulators). The server
    // ONLY honors this in non-production deployments — see resolveRazorpayMode.
    mode: z.enum(['test', 'live']).optional(),
  }),
});

export const verifyRazorpayPaymentSchema = z.object({
  body: z.object({
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
    mode: z.enum(['test', 'live']).optional(),
    // tier is intentionally NOT accepted here — we derive it from the order's
    // server-set notes inside the handler. Trusting a client-supplied tier
    // would let a user pay for the cheapest plan and claim the most expensive.
  }),
});

/**
 * Create a Razorpay order pinned to a tier. The amount is taken from
 * SUBSCRIPTION_PLANS server-side — never from the client — so a
 * tampered request can't pay ₹1 for the yearly plan.
 */
export const razorpayCreateOrder = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { tier, mode: requestedMode } = req.body as {
    tier: SubscriptionTier;
    mode?: RazorpayMode;
  };
  const plan = SUBSCRIPTION_PLANS[tier];
  if (!plan || plan.priceInr <= 0) throw ApiError.badRequest('Invalid paid tier');

  // Resolve which credential set to use. In production this is always 'live'
  // regardless of what the client asks; in dev/staging it honors a debug
  // build's request for 'test' if test keys are configured.
  const mode = resolveRazorpayMode(requestedMode);

  const order = await createRazorpayOrder({
    amountPaise: plan.priceInr * 100,
    currency: 'INR',
    receipt: `sub_${req.user.id.slice(-12)}_${Date.now().toString(36)}`,
    notes: {
      userId: req.user.id,
      tier,
      mode,
    },
    mode,
  });

  res.status(201).json({
    success: true,
    data: {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      // Return the keyId for the resolved mode so the client opens the
      // Razorpay native sheet with matching credentials.
      keyId: getRazorpayKeyId(mode),
      tier,
      planName: plan.name,
      mode,
    },
  });
});

/**
 * Verify a Razorpay payment + activate the subscription on success.
 *
 * Defense layers:
 *  1. HMAC signature check → proves the success callback came from Razorpay.
 *  2. Fetch the order from Razorpay → re-derive userId/tier/amount from the
 *     server-set `notes` (set during order creation), never trust the client.
 *  3. Ownership: order's `notes.userId` must match the authenticated user —
 *     stops a leaked order_id from being used to activate a different account.
 *  4. Amount: order amount must equal the current plan price in paise —
 *     stops a tier-swap attack (pay weekly, claim yearly).
 *  5. Idempotency: subsequent calls with the same paymentId return the
 *     existing record, so the webhook and the client can both safely activate.
 */
export const razorpayVerifyPayment = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    mode: requestedMode,
  } = req.body as {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
    mode?: RazorpayMode;
  };

  const mode = resolveRazorpayMode(requestedMode);

  // 1. HMAC signature. Spoofing the mode here is self-defeating: the signature
  //    Razorpay produced was HMAC'd with the *correct* mode's secret, so a
  //    mismatched `mode` will fail verification.
  const ok = verifyPaymentSignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
    mode,
  });
  if (!ok) {
    logger.warn(`Razorpay signature mismatch for user ${req.user.id} order ${razorpay_order_id} mode=${mode}`);
    throw ApiError.badRequest('Payment signature verification failed');
  }

  // 2. Re-fetch the order from Razorpay so tier/amount/userId come from the
  //    server-set notes, not the client request body.
  const order = await fetchRazorpayOrder(razorpay_order_id, mode);
  const notes = order.notes ?? {};
  const orderUserId = notes.userId;
  const orderTier = notes.tier as SubscriptionTier | undefined;

  // 3. Ownership.
  if (!orderUserId || orderUserId !== req.user.id) {
    logger.warn(
      `Order ownership mismatch: order.notes.userId=${orderUserId} req.user.id=${req.user.id}`,
    );
    throw ApiError.forbidden('Order does not belong to this user');
  }

  if (!orderTier || !SUBSCRIPTION_PLANS[orderTier]) {
    throw ApiError.badRequest('Order is missing a valid tier');
  }

  // 4 + 5. Amount check + idempotent activation, shared with webhook.
  const sub = await activateSubscriptionAfterPayment({
    userId: req.user.id,
    tier: orderTier,
    paymentId: razorpay_payment_id,
    orderId: razorpay_order_id,
    amountPaise: order.amount,
  });

  res.status(201).json({ success: true, data: sub });
});

/**
 * Webhook for renewal / payment.failed / refund events.
 * Mounted on a route that uses `express.raw({ type: 'application/json' })`
 * so we can verify the signature against the exact bytes Razorpay sent.
 */
export const razorpayWebhook = asyncHandler(async (req: Request, res: Response) => {
  // Try both webhook secrets. Whichever one verifies tells us which mode
  // (test or live) sent this delivery — and that's the mode we must use
  // when fetching the order/payment back. A single backend can serve both
  // modes when test webhook is also configured in Razorpay dashboard.
  const liveSecret = env.RAZORPAY_WEBHOOK_SECRET;
  const testSecret = env.RAZORPAY_TEST_WEBHOOK_SECRET;
  if (!liveSecret && !testSecret) {
    logger.error('No Razorpay webhook secrets configured (live or test); rejecting');
    throw ApiError.internal('Webhook not configured');
  }

  const signature = req.headers['x-razorpay-signature'];
  if (typeof signature !== 'string') {
    throw ApiError.badRequest('Missing x-razorpay-signature header');
  }

  // `req.body` is a Buffer here (raw body parser).
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);

  let mode: RazorpayMode | null = null;
  if (liveSecret && verifyWebhookSignature({ rawBody, signature, webhookSecret: liveSecret })) {
    mode = 'live';
  } else if (testSecret && verifyWebhookSignature({ rawBody, signature, webhookSecret: testSecret })) {
    mode = 'test';
  }
  if (!mode) {
    logger.warn('Razorpay webhook signature mismatch (tried both live and test secrets)');
    throw ApiError.badRequest('Invalid signature');
  }

  type RazorpayPaymentEntity = {
    id: string;
    order_id: string;
    status: string;
    amount: number;
    error_code?: string;
    error_description?: string;
    notes?: Record<string, string>;
  };
  type RazorpayRefundEntity = {
    id: string;
    payment_id: string;
    amount: number;
    status: string;
  };
  let payload: {
    event?: string;
    payload?: {
      payment?: { entity?: RazorpayPaymentEntity };
      refund?: { entity?: RazorpayRefundEntity };
    };
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw ApiError.badRequest('Invalid JSON payload');
  }

  const event = payload.event;
  logger.info(`Razorpay webhook received: ${event}`);

  // Dedupe by Razorpay's per-delivery event id. Razorpay retries failed
  // deliveries and can resend after our 2xx if their ack wire-times-out,
  // so the same id may show up more than once. Insert-first lets the
  // unique index enforce exactly-once processing across racing deliveries.
  const eventId = req.headers['x-razorpay-event-id'];
  if (typeof eventId === 'string' && eventId.length > 0) {
    try {
      await WebhookEvent.create({ eventId, event: event ?? 'unknown' });
    } catch (err: unknown) {
      const isDup =
        typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000;
      if (isDup) {
        logger.info(`Webhook ${eventId} (${event}) already processed; skipping`);
        res.json({ success: true });
        return;
      }
      throw err;
    }
  }

  // ALWAYS respond 200 quickly to Razorpay (they retry on non-2xx and delivery
  // delays). We do work first, but never let an internal error bubble — log
  // and acknowledge so retries don't pile up after a transient DB blip.
  try {
    if (event === 'payment.captured' || event === 'order.paid') {
      const payment = payload.payload?.payment?.entity;
      if (!payment) {
        logger.warn(`Webhook ${event} missing payment.entity`);
        res.json({ success: true });
        return;
      }

      // Re-fetch the order so notes (userId/tier) come from Razorpay's
      // authoritative copy, not the webhook payload (which an attacker
      // could craft if they ever got the webhook secret — defense in depth).
      const order = await fetchRazorpayOrder(payment.order_id, mode);
      const notes = order.notes ?? {};
      const userId = notes.userId;
      const tier = notes.tier as SubscriptionTier | undefined;

      if (!userId || !tier || !SUBSCRIPTION_PLANS[tier]) {
        logger.warn(
          `Webhook ${event} for order ${payment.order_id}: missing/invalid notes (userId=${userId} tier=${tier}). Ignoring.`,
        );
        res.json({ success: true });
        return;
      }

      // Confirm the payment is actually captured before activating. The
      // signature only proves the message came from Razorpay; the status
      // proves money was settled.
      const fullPayment = await fetchRazorpayPayment(payment.id, mode);
      if (fullPayment.status !== 'captured') {
        logger.warn(
          `Webhook ${event} payment ${payment.id} status=${fullPayment.status}, not capturing yet`,
        );
        res.json({ success: true });
        return;
      }

      await activateSubscriptionAfterPayment({
        userId,
        tier,
        paymentId: payment.id,
        orderId: payment.order_id,
        amountPaise: order.amount,
      });
    } else if (event === 'payment.failed') {
      // Money never moved — nothing to undo. Log enough to investigate user
      // complaints without dumping PII.
      const payment = payload.payload?.payment?.entity;
      if (payment) {
        logger.warn(
          `Razorpay payment.failed: payment=${payment.id} order=${payment.order_id} ` +
            `code=${payment.error_code ?? '-'} desc=${payment.error_description ?? '-'}`,
        );
      }
    } else if (event === 'refund.created' || event === 'refund.processed') {
      // Money refunded — revoke access. Find the sub by paymentId and mark
      // refunded; downgrade the user back to free.
      const refund = payload.payload?.refund?.entity;
      if (!refund) {
        logger.warn(`Webhook ${event} missing refund.entity`);
        res.json({ success: true });
        return;
      }
      const sub = await Subscription.findOneAndUpdate(
        { paymentId: refund.payment_id },
        { $set: { status: 'refunded', cancelledAt: new Date(), autoRenew: false } },
        { new: true },
      );
      if (!sub) {
        logger.warn(`Refund for unknown payment ${refund.payment_id}`);
      } else {
        await User.findByIdAndUpdate(sub.user, {
          $set: { 'subscription.tier': 'free', 'subscription.status': 'refunded' },
        });
        logger.info(
          `Subscription refunded: user=${sub.user} payment=${refund.payment_id} refund=${refund.id}`,
        );
      }
    }
  } catch (err) {
    logger.error('Razorpay webhook processing failed', err instanceof Error ? err.message : err);
    // Still 200 — see comment above. Razorpay's retry would just re-trigger
    // the same failing path. We rely on monitoring/alerting on the log line.
  }

  res.json({ success: true });
});
