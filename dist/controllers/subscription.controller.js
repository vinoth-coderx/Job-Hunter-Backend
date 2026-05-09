"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.razorpayWebhook = exports.razorpayVerifyPayment = exports.razorpayCreateOrder = exports.verifyRazorpayPaymentSchema = exports.createRazorpayOrderSchema = exports.subscriptionHistory = exports.cancelSubscription = exports.subscribe = exports.currentSubscription = exports.listPlans = exports.subscribeSchema = void 0;
const zod_1 = require("zod");
const Subscription_1 = require("../models/Subscription");
const User_1 = require("../models/User");
const WebhookEvent_1 = require("../models/WebhookEvent");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const logger_1 = require("../utils/logger");
const env_1 = require("../config/env");
const razorpay_service_1 = require("../services/razorpay.service");
const activateSubscriptionAfterPayment = async (params) => {
    const { userId, tier, paymentId, orderId, amountPaise } = params;
    const plan = Subscription_1.SUBSCRIPTION_PLANS[tier];
    if (!plan || plan.priceInr <= 0) {
        throw ApiError_1.ApiError.badRequest(`Invalid paid tier: ${tier}`);
    }
    if (amountPaise !== plan.priceInr * 100) {
        logger_1.logger.warn(`Amount mismatch for order ${orderId}: paid ${amountPaise} paise, plan expects ${plan.priceInr * 100}`);
        throw ApiError_1.ApiError.badRequest('Order amount does not match plan price');
    }
    const existing = await Subscription_1.Subscription.findOne({ paymentId });
    if (existing)
        return existing;
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    await Subscription_1.Subscription.updateMany({ user: userId, status: 'active' }, { $set: { status: 'cancelled', cancelledAt: new Date() } });
    try {
        const sub = await new Subscription_1.Subscription({
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
        await User_1.User.findByIdAndUpdate(userId, {
            $set: {
                'subscription.tier': tier,
                'subscription.status': 'active',
                'subscription.startDate': startDate,
                'subscription.endDate': endDate,
                'subscription.paymentId': paymentId,
            },
        });
        logger_1.logger.info(`Subscription activated: user=${userId} tier=${tier} payment=${paymentId}`);
        return sub;
    }
    catch (err) {
        const isDup = typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
        if (!isDup)
            throw err;
        const winner = await Subscription_1.Subscription.findOne({ paymentId });
        if (!winner)
            throw err;
        return winner;
    }
};
exports.subscribeSchema = zod_1.z.object({
    body: zod_1.z.object({
        tier: zod_1.z.enum(['free', 'weekly', 'monthly', 'yearly']),
        paymentMethod: zod_1.z.enum(['razorpay', 'stripe', 'manual']).optional(),
        paymentId: zod_1.z.string().optional(),
        orderId: zod_1.z.string().optional(),
    }),
});
exports.listPlans = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    res.json({ success: true, data: Object.values(Subscription_1.SUBSCRIPTION_PLANS) });
});
exports.currentSubscription = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const active = await Subscription_1.Subscription.findOne({
        user: req.user._id,
        status: 'active',
        endDate: { $gt: new Date() },
    }).sort({ endDate: -1 });
    const user = await User_1.User.findById(req.user._id);
    res.json({
        success: true,
        data: {
            tier: user?.subscription.tier || 'free',
            status: user?.subscription.status || 'active',
            activeSubscription: active,
            plan: Subscription_1.SUBSCRIPTION_PLANS[user?.subscription.tier || 'free'],
        },
    });
});
exports.subscribe = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { tier, paymentMethod, paymentId, orderId } = req.body;
    const plan = Subscription_1.SUBSCRIPTION_PLANS[tier];
    if (!plan)
        throw ApiError_1.ApiError.badRequest('Invalid subscription tier');
    if (tier !== 'free' && !paymentId) {
        throw ApiError_1.ApiError.badRequest('Payment ID required for paid tiers');
    }
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    await Subscription_1.Subscription.updateMany({ user: req.user._id, status: 'active' }, { $set: { status: 'cancelled', cancelledAt: new Date() } });
    const sub = await Subscription_1.Subscription.create({
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
    await User_1.User.findByIdAndUpdate(req.user._id, {
        $set: {
            'subscription.tier': tier,
            'subscription.status': 'active',
            'subscription.startDate': startDate,
            'subscription.endDate': endDate,
            'subscription.paymentId': paymentId,
        },
    });
    logger_1.logger.info(`User ${req.user.email} subscribed to ${tier}`);
    res.status(201).json({ success: true, message: 'Subscription activated', data: sub });
});
exports.cancelSubscription = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const sub = await Subscription_1.Subscription.findOneAndUpdate({ user: req.user._id, status: 'active' }, { $set: { status: 'cancelled', cancelledAt: new Date(), autoRenew: false } }, { new: true });
    if (!sub)
        throw ApiError_1.ApiError.notFound('No active subscription');
    await User_1.User.findByIdAndUpdate(req.user._id, {
        $set: { 'subscription.tier': 'free', 'subscription.status': 'cancelled' },
    });
    res.json({ success: true, message: 'Subscription cancelled', data: sub });
});
exports.subscriptionHistory = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const subs = await Subscription_1.Subscription.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: subs });
});
exports.createRazorpayOrderSchema = zod_1.z.object({
    body: zod_1.z.object({
        tier: zod_1.z.enum(['weekly', 'monthly', 'yearly']),
        mode: zod_1.z.enum(['test', 'live']).optional(),
    }),
});
exports.verifyRazorpayPaymentSchema = zod_1.z.object({
    body: zod_1.z.object({
        razorpay_order_id: zod_1.z.string().min(1),
        razorpay_payment_id: zod_1.z.string().min(1),
        razorpay_signature: zod_1.z.string().min(1),
        mode: zod_1.z.enum(['test', 'live']).optional(),
    }),
});
exports.razorpayCreateOrder = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { tier, mode: requestedMode } = req.body;
    const plan = Subscription_1.SUBSCRIPTION_PLANS[tier];
    if (!plan || plan.priceInr <= 0)
        throw ApiError_1.ApiError.badRequest('Invalid paid tier');
    const mode = (0, razorpay_service_1.resolveRazorpayMode)(requestedMode);
    const order = await (0, razorpay_service_1.createRazorpayOrder)({
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
            keyId: (0, razorpay_service_1.getRazorpayKeyId)(mode),
            tier,
            planName: plan.name,
            mode,
        },
    });
});
exports.razorpayVerifyPayment = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, mode: requestedMode, } = req.body;
    const mode = (0, razorpay_service_1.resolveRazorpayMode)(requestedMode);
    const ok = (0, razorpay_service_1.verifyPaymentSignature)({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
        mode,
    });
    if (!ok) {
        logger_1.logger.warn(`Razorpay signature mismatch for user ${req.user.id} order ${razorpay_order_id} mode=${mode}`);
        throw ApiError_1.ApiError.badRequest('Payment signature verification failed');
    }
    const order = await (0, razorpay_service_1.fetchRazorpayOrder)(razorpay_order_id, mode);
    const notes = order.notes ?? {};
    const orderUserId = notes.userId;
    const orderTier = notes.tier;
    if (!orderUserId || orderUserId !== req.user.id) {
        logger_1.logger.warn(`Order ownership mismatch: order.notes.userId=${orderUserId} req.user.id=${req.user.id}`);
        throw ApiError_1.ApiError.forbidden('Order does not belong to this user');
    }
    if (!orderTier || !Subscription_1.SUBSCRIPTION_PLANS[orderTier]) {
        throw ApiError_1.ApiError.badRequest('Order is missing a valid tier');
    }
    const sub = await activateSubscriptionAfterPayment({
        userId: req.user.id,
        tier: orderTier,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        amountPaise: order.amount,
    });
    res.status(201).json({ success: true, data: sub });
});
exports.razorpayWebhook = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const liveSecret = env_1.env.RAZORPAY_WEBHOOK_SECRET;
    const testSecret = env_1.env.RAZORPAY_TEST_WEBHOOK_SECRET;
    if (!liveSecret && !testSecret) {
        logger_1.logger.error('No Razorpay webhook secrets configured (live or test); rejecting');
        throw ApiError_1.ApiError.internal('Webhook not configured');
    }
    const signature = req.headers['x-razorpay-signature'];
    if (typeof signature !== 'string') {
        throw ApiError_1.ApiError.badRequest('Missing x-razorpay-signature header');
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    let mode = null;
    if (liveSecret && (0, razorpay_service_1.verifyWebhookSignature)({ rawBody, signature, webhookSecret: liveSecret })) {
        mode = 'live';
    }
    else if (testSecret && (0, razorpay_service_1.verifyWebhookSignature)({ rawBody, signature, webhookSecret: testSecret })) {
        mode = 'test';
    }
    if (!mode) {
        logger_1.logger.warn('Razorpay webhook signature mismatch (tried both live and test secrets)');
        throw ApiError_1.ApiError.badRequest('Invalid signature');
    }
    let payload;
    try {
        payload = JSON.parse(rawBody);
    }
    catch {
        throw ApiError_1.ApiError.badRequest('Invalid JSON payload');
    }
    const event = payload.event;
    logger_1.logger.info(`Razorpay webhook received: ${event}`);
    const eventId = req.headers['x-razorpay-event-id'];
    if (typeof eventId === 'string' && eventId.length > 0) {
        try {
            await WebhookEvent_1.WebhookEvent.create({ eventId, event: event ?? 'unknown' });
        }
        catch (err) {
            const isDup = typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
            if (isDup) {
                logger_1.logger.info(`Webhook ${eventId} (${event}) already processed; skipping`);
                res.json({ success: true });
                return;
            }
            throw err;
        }
    }
    try {
        if (event === 'payment.captured' || event === 'order.paid') {
            const payment = payload.payload?.payment?.entity;
            if (!payment) {
                logger_1.logger.warn(`Webhook ${event} missing payment.entity`);
                res.json({ success: true });
                return;
            }
            const order = await (0, razorpay_service_1.fetchRazorpayOrder)(payment.order_id, mode);
            const notes = order.notes ?? {};
            const userId = notes.userId;
            const tier = notes.tier;
            if (!userId || !tier || !Subscription_1.SUBSCRIPTION_PLANS[tier]) {
                logger_1.logger.warn(`Webhook ${event} for order ${payment.order_id}: missing/invalid notes (userId=${userId} tier=${tier}). Ignoring.`);
                res.json({ success: true });
                return;
            }
            const fullPayment = await (0, razorpay_service_1.fetchRazorpayPayment)(payment.id, mode);
            if (fullPayment.status !== 'captured') {
                logger_1.logger.warn(`Webhook ${event} payment ${payment.id} status=${fullPayment.status}, not capturing yet`);
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
        }
        else if (event === 'payment.failed') {
            const payment = payload.payload?.payment?.entity;
            if (payment) {
                logger_1.logger.warn(`Razorpay payment.failed: payment=${payment.id} order=${payment.order_id} ` +
                    `code=${payment.error_code ?? '-'} desc=${payment.error_description ?? '-'}`);
            }
        }
        else if (event === 'refund.created' || event === 'refund.processed') {
            const refund = payload.payload?.refund?.entity;
            if (!refund) {
                logger_1.logger.warn(`Webhook ${event} missing refund.entity`);
                res.json({ success: true });
                return;
            }
            const sub = await Subscription_1.Subscription.findOneAndUpdate({ paymentId: refund.payment_id }, { $set: { status: 'refunded', cancelledAt: new Date(), autoRenew: false } }, { new: true });
            if (!sub) {
                logger_1.logger.warn(`Refund for unknown payment ${refund.payment_id}`);
            }
            else {
                await User_1.User.findByIdAndUpdate(sub.user, {
                    $set: { 'subscription.tier': 'free', 'subscription.status': 'refunded' },
                });
                logger_1.logger.info(`Subscription refunded: user=${sub.user} payment=${refund.payment_id} refund=${refund.id}`);
            }
        }
    }
    catch (err) {
        logger_1.logger.error('Razorpay webhook processing failed', err instanceof Error ? err.message : err);
    }
    res.json({ success: true });
});
