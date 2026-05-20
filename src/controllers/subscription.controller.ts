import { Request, Response } from 'express';
import { z } from 'zod';
import { Subscription } from '../models/Subscription';
import { User } from '../models/User';
import { WebhookEvent } from '../models/WebhookEvent';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { getAppConfig } from '../services/config/config.service';
import {
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchRazorpayOrder,
  fetchRazorpayPayment,
  getRazorpayKeyId,
} from '../services/razorpay.service';
import { runWithMode, type RuntimeMode } from '../config/dbConnections';
import { grantCoins, getBalance } from '../services/coins/coin.service';
import { getPlan, getActivePlans } from '../services/subscriptionPlans.service';

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
  tier: string;
  paymentId: string;
  orderId: string;
  amountPaise: number;
}) => {
  const { userId, tier, paymentId, orderId, amountPaise } = params;

  const plan = await getPlan(tier);
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
    tier: z.string().min(1).max(40),
    paymentMethod: z.enum(['razorpay', 'stripe', 'manual']).optional(),
    paymentId: z.string().optional(),
    orderId: z.string().optional(),
  }),
});

export const listPlans = asyncHandler(async (_req: AuthRequest, res: Response) => {
  // Active-only — admin-deactivated plans should disappear from the
  // user pricing page. `coinCost` is on the plan record itself now.
  const plans = await getActivePlans();
  res.json({ success: true, data: plans });
});

export const redeemWithCoinsSchema = z.object({
  body: z.object({
    tier: z.string().min(1).max(40),
  }),
});

const todayKey = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Activates a paid tier using the seeker's coin balance instead of a
 * Razorpay payment. Designed defensively because coins are a soft
 * currency the user *earned* — losing them to a partial failure is the
 * worst possible UX:
 *
 *   1. Cheap pre-check rejects insufficient balance up-front so we
 *      never half-commit just to bounce the user.
 *   2. Coin deduction is idempotency-keyed `plan_redeem:<tier>:<date>`
 *      so accidental double-taps within the same day return the
 *      original deduction's result instead of charging twice.
 *   3. If the subscription write fails AFTER the deduction lands, we
 *      issue a compensating refund grant tagged with the same source
 *      ref so the audit trail makes the rollback obvious.
 */
export const redeemWithCoins = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { tier } = req.body as z.infer<
      typeof redeemWithCoinsSchema
    >['body'];

    const plan = await getPlan(tier);
    if (!plan) throw ApiError.badRequest('Invalid subscription tier');

    const cost = plan.coinCost ?? 0;
    if (!cost || cost <= 0) {
      throw ApiError.badRequest(`Tier '${tier}' is not redeemable with coins`);
    }

    // 1. Cheap pre-check — saves a CoinLedger insert + rollback in the
    //    common "user mis-clicked while broke" path.
    const currentBalance = await getBalance(req.user.id);
    if (currentBalance < cost) {
      throw ApiError.badRequest(
        `Not enough coins. Need ${cost}, you have ${currentBalance}.`,
      );
    }

    // 2. Deduct. Date-keyed idempotency = at most one redemption per
    //    tier per day; a double-tap returns 409 instead of double-spending.
    const idempotencyKey = `plan_redeem:${tier}:${todayKey()}`;
    const deduction = await grantCoins({
      user: req.user.id,
      amount: -cost,
      source: 'plan_redeem',
      idempotencyKey,
      meta: { tier },
    });
    if (!deduction.granted) {
      if (deduction.reason === 'duplicate') {
        throw ApiError.conflict(
          `This plan was already redeemed today. Try again tomorrow.`,
        );
      }
      if (deduction.reason === 'invalid_amount') {
        // Concurrent race or balance changed between pre-check and deduct.
        throw ApiError.badRequest(
          `Not enough coins. Have ${deduction.balance}, need ${cost}.`,
        );
      }
      throw ApiError.internal('Could not deduct coins');
    }

    // 3. Activate the subscription. Anything failing past this point
    //    triggers a compensating refund so the user never loses coins
    //    without getting their plan.
    try {
      const startDate = new Date();
      const endDate = new Date(
        startDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000,
      );

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
        amountPaid: 0,
        currency: 'INR',
        paymentMethod: 'coins',
        paymentId: `coins:${cost}:${idempotencyKey}`,
        autoRenew: false,
      });

      await User.findByIdAndUpdate(req.user._id, {
        $set: {
          'subscription.tier': tier,
          'subscription.status': 'active',
          'subscription.startDate': startDate,
          'subscription.endDate': endDate,
          'subscription.paymentId': sub.paymentId,
        },
      });

      logger.info(
        `Coin redemption: user=${req.user.id} tier=${tier} cost=${cost}`,
      );

      res.status(201).json({
        success: true,
        message: 'Plan activated with coins',
        data: sub,
        coinsSpent: cost,
        coinsBalance: deduction.balance,
      });
    } catch (err) {
      // Compensating refund. Same idempotency-key prefix so the refund
      // is permanently tied to the failed redemption attempt.
      logger.error(
        `Coin redemption rollback for user=${req.user.id}: ${err instanceof Error ? err.message : err}`,
      );
      await grantCoins({
        user: req.user.id,
        amount: cost,
        source: 'admin_adjust',
        idempotencyKey: `${idempotencyKey}:refund`,
        meta: { reason: 'subscription_activation_failed', tier },
      }).catch((refundErr) => {
        logger.error('Refund failed — manual intervention needed', refundErr);
      });
      throw err;
    }
  },
);

export const currentSubscription = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const active = await Subscription.findOne({
    user: req.user._id,
    status: 'active',
    endDate: { $gt: new Date() },
  }).sort({ endDate: -1 });

  const user = await User.findById(req.user._id);
  const tier = user?.subscription.tier || 'free';
  res.json({
    success: true,
    data: {
      tier,
      status: user?.subscription.status || 'active',
      activeSubscription: active,
      plan: await getPlan(tier),
    },
  });
});

export const subscribe = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { tier, paymentMethod, paymentId, orderId } = req.body as {
    tier: string;
    paymentMethod?: 'razorpay' | 'stripe' | 'manual';
    paymentId?: string;
    orderId?: string;
  };

  const plan = await getPlan(tier);
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
    tier: z.string().min(1).max(40),
  }),
});

export const verifyRazorpayPaymentSchema = z.object({
  body: z.object({
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
    // tier is intentionally NOT accepted here — we derive it from the order's
    // server-set notes inside the handler. Trusting a client-supplied tier
    // would let a user pay for the cheapest plan and claim the most expensive.
  }),
});

/**
 * Create a Razorpay order pinned to a tier. The amount is taken from
 * the SubscriptionPlan record server-side — never from the client — so a
 * tampered request can't pay ₹1 for the yearly plan.
 */
export const razorpayCreateOrder = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { tier } = req.body as { tier: string };
  const plan = await getPlan(tier);
  if (!plan || !plan.isActive || plan.priceInr <= 0) {
    throw ApiError.badRequest('Invalid paid tier');
  }

  // The active runtime mode (test/live, picked by NODE_ENV at boot) decides
  // which Mongo's RAZORPAY_KEY_ID/SECRET we end up using — no separate
  // _TEST_ key names; same key, different DB.
  const order = await createRazorpayOrder({
    amountPaise: plan.priceInr * 100,
    currency: 'INR',
    receipt: `sub_${req.user.id.slice(-12)}_${Date.now().toString(36)}`,
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
      keyId: getRazorpayKeyId(),
      tier,
      planName: plan.name,
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
  } = req.body as {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  };

  // 1. HMAC signature. Keys come from the active-mode DB (set at boot by
  //    NODE_ENV); the order was created under the same mode so the secret
  //    matches.
  const ok = verifyPaymentSignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });
  if (!ok) {
    logger.warn(`Razorpay signature mismatch for user ${req.user.id} order ${razorpay_order_id}`);
    throw ApiError.badRequest('Payment signature verification failed');
  }

  // 2. Re-fetch the order from Razorpay so tier/amount/userId come from the
  //    server-set notes, not the client request body.
  const order = await fetchRazorpayOrder(razorpay_order_id);
  const notes = order.notes ?? {};
  const orderUserId = notes.userId;
  const orderTier = notes.tier;

  // 3. Ownership.
  if (!orderUserId || orderUserId !== req.user.id) {
    logger.warn(
      `Order ownership mismatch: order.notes.userId=${orderUserId} req.user.id=${req.user.id}`,
    );
    throw ApiError.forbidden('Order does not belong to this user');
  }

  if (!orderTier || !(await getPlan(orderTier))) {
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
  // The public webhook route has no X-Runtime-Mode header, so we resolve the
  // mode by trying each DB's webhook secret in turn — whichever verifies the
  // HMAC tells us which Mongo holds the keys that issued this payment, and
  // we pin the rest of the handler to that mode via runWithMode.
  const liveSecret = await runWithMode('live', async () =>
    getAppConfig('RAZORPAY_WEBHOOK_SECRET'),
  );
  const testSecret = await runWithMode('test', async () =>
    getAppConfig('RAZORPAY_WEBHOOK_SECRET'),
  );
  if (!liveSecret && !testSecret) {
    logger.error('No Razorpay webhook secret configured in either DB; rejecting');
    throw ApiError.internal('Webhook not configured');
  }

  const signature = req.headers['x-razorpay-signature'];
  if (typeof signature !== 'string') {
    throw ApiError.badRequest('Missing x-razorpay-signature header');
  }

  // `req.body` is a Buffer here (raw body parser).
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);

  let mode: RuntimeMode | null = null;
  if (liveSecret && verifyWebhookSignature({ rawBody, signature, webhookSecret: liveSecret })) {
    mode = 'live';
  } else if (testSecret && verifyWebhookSignature({ rawBody, signature, webhookSecret: testSecret })) {
    mode = 'test';
  }
  if (!mode) {
    logger.warn('Razorpay webhook signature mismatch (tried both live and test DB secrets)');
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
      // Pin to the resolved mode so getAppConfig reads the right DB's keys.
      const order = await runWithMode(mode, async () =>
        fetchRazorpayOrder(payment.order_id),
      );
      const notes = order.notes ?? {};
      const userId = notes.userId;
      const tier = notes.tier;

      if (!userId || !tier || !(await getPlan(tier))) {
        logger.warn(
          `Webhook ${event} for order ${payment.order_id}: missing/invalid notes (userId=${userId} tier=${tier}). Ignoring.`,
        );
        res.json({ success: true });
        return;
      }

      // Confirm the payment is actually captured before activating. The
      // signature only proves the message came from Razorpay; the status
      // proves money was settled.
      const fullPayment = await runWithMode(mode, async () =>
        fetchRazorpayPayment(payment.id),
      );
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
