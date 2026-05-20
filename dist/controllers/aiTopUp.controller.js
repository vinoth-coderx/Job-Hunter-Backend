"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiTopUpHistory = exports.verifyAiTopUpPayment = exports.verifyAiTopUpSchema = exports.createAiTopUpOrder = exports.createAiTopUpOrderSchema = exports.listAiTopUpPacks = exports.findPack = void 0;
const zod_1 = require("zod");
const User_1 = require("../models/User");
const AiCreditTopUp_1 = require("../models/AiCreditTopUp");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const logger_1 = require("../utils/logger");
const razorpay_service_1 = require("../services/razorpay.service");
const config_service_1 = require("../services/config/config.service");
const dbConnections_1 = require("../config/dbConnections");
const DEFAULT_PACKS = [
    { id: 'starter', label: '50 credits', credits: 50, priceInr: 49 },
    {
        id: 'pro',
        label: '250 credits',
        credits: 250,
        priceInr: 199,
        bestValue: true,
    },
    { id: 'mega', label: '700 credits', credits: 700, priceInr: 499 },
];
const getPacks = () => {
    const raw = (0, config_service_1.getAppConfig)('AI_TOPUP_PACKS_JSON');
    if (!raw)
        return DEFAULT_PACKS;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return DEFAULT_PACKS;
        const out = [];
        for (const p of parsed) {
            if (!p || typeof p !== 'object')
                continue;
            const o = p;
            const id = typeof o.id === 'string' ? o.id.trim() : '';
            const label = typeof o.label === 'string' ? o.label.trim() : '';
            const credits = typeof o.credits === 'number' && Number.isFinite(o.credits)
                ? Math.round(o.credits)
                : 0;
            const priceInr = typeof o.priceInr === 'number' && Number.isFinite(o.priceInr)
                ? Math.round(o.priceInr)
                : 0;
            if (!id || !label || credits <= 0 || priceInr <= 0)
                continue;
            out.push({
                id,
                label,
                credits,
                priceInr,
                bestValue: o.bestValue === true,
            });
        }
        return out.length > 0 ? out : DEFAULT_PACKS;
    }
    catch {
        return DEFAULT_PACKS;
    }
};
const findPack = (id) => getPacks().find((p) => p.id === id);
exports.findPack = findPack;
exports.listAiTopUpPacks = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    res.json({ success: true, data: getPacks() });
});
exports.createAiTopUpOrderSchema = zod_1.z.object({
    body: zod_1.z.object({
        packId: zod_1.z.string().min(1).max(60),
    }),
});
exports.createAiTopUpOrder = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { packId } = req.body;
    const pack = (0, exports.findPack)(packId);
    if (!pack)
        throw ApiError_1.ApiError.badRequest('Unknown top-up pack');
    const order = await (0, razorpay_service_1.createRazorpayOrder)({
        amountPaise: pack.priceInr * 100,
        currency: 'INR',
        receipt: `aitop_${req.user.id.slice(-12)}_${Date.now().toString(36)}`,
        notes: {
            userId: req.user.id,
            kind: 'ai_topup',
            packId: pack.id,
            credits: String(pack.credits),
        },
    });
    res.status(201).json({
        success: true,
        data: {
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: (0, razorpay_service_1.getRazorpayKeyId)(),
            packId: pack.id,
            credits: pack.credits,
            priceInr: pack.priceInr,
        },
    });
});
exports.verifyAiTopUpSchema = zod_1.z.object({
    body: zod_1.z.object({
        razorpay_order_id: zod_1.z.string().min(1),
        razorpay_payment_id: zod_1.z.string().min(1),
        razorpay_signature: zod_1.z.string().min(1),
    }),
});
exports.verifyAiTopUpPayment = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, } = req.body;
    const ok = (0, razorpay_service_1.verifyPaymentSignature)({
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
    });
    if (!ok) {
        logger_1.logger.warn(`AI top-up signature mismatch user=${req.user.id} order=${razorpay_order_id}`);
        throw ApiError_1.ApiError.badRequest('Payment signature verification failed');
    }
    const order = await (0, razorpay_service_1.fetchRazorpayOrder)(razorpay_order_id);
    const notes = order.notes ?? {};
    if (notes.kind !== 'ai_topup') {
        throw ApiError_1.ApiError.badRequest('Order is not an AI top-up');
    }
    if (!notes.userId || notes.userId !== req.user.id) {
        throw ApiError_1.ApiError.forbidden('Order does not belong to this user');
    }
    const packId = notes.packId;
    const pack = packId ? (0, exports.findPack)(packId) : undefined;
    if (!pack)
        throw ApiError_1.ApiError.badRequest('Order pack is no longer available');
    if (order.amount !== pack.priceInr * 100) {
        throw ApiError_1.ApiError.badRequest('Order amount does not match pack price');
    }
    const existing = await AiCreditTopUp_1.AiCreditTopUp.findOne({
        paymentId: razorpay_payment_id,
    }).lean();
    if (existing) {
        const user = await User_1.User.findById(req.user.id)
            .select('aiTopUpCredits')
            .lean();
        res.json({
            success: true,
            data: {
                alreadyCredited: true,
                creditsGranted: existing.credits,
                balance: user?.aiTopUpCredits ?? 0,
            },
        });
        return;
    }
    let granted = false;
    try {
        await AiCreditTopUp_1.AiCreditTopUp.create({
            user: req.user.id,
            packId: pack.id,
            credits: pack.credits,
            amountInr: pack.priceInr,
            paymentId: razorpay_payment_id,
            orderId: razorpay_order_id,
            mode: (0, dbConnections_1.currentRuntimeMode)(),
        });
        granted = true;
    }
    catch (err) {
        logger_1.logger.info(`AI top-up ledger insert race for ${razorpay_payment_id}: ${err.message}`);
    }
    let balance = 0;
    if (granted) {
        const updated = await User_1.User.findByIdAndUpdate(req.user.id, { $inc: { aiTopUpCredits: pack.credits } }, { new: true, projection: { aiTopUpCredits: 1 } }).lean();
        balance = Number(updated?.aiTopUpCredits ?? 0);
    }
    else {
        const user = await User_1.User.findById(req.user.id)
            .select('aiTopUpCredits')
            .lean();
        balance = Number(user?.aiTopUpCredits ?? 0);
    }
    res.json({
        success: true,
        data: {
            alreadyCredited: !granted,
            creditsGranted: granted ? pack.credits : 0,
            balance,
        },
    });
});
exports.aiTopUpHistory = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const rows = await AiCreditTopUp_1.AiCreditTopUp.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
    res.json({
        success: true,
        data: rows.map((r) => ({
            id: String(r._id),
            packId: r.packId,
            credits: r.credits,
            amountInr: r.amountInr,
            paymentId: r.paymentId,
            createdAt: r.createdAt,
        })),
    });
});
