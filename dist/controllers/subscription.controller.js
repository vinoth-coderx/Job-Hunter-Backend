"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscriptionHistory = exports.cancelSubscription = exports.subscribe = exports.currentSubscription = exports.listPlans = exports.subscribeSchema = void 0;
const zod_1 = require("zod");
const Subscription_1 = require("../models/Subscription");
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const logger_1 = require("../utils/logger");
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
