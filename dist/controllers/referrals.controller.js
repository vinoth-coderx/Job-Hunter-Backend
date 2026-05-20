"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.claimReferral = exports.claimReferralSchema = exports.getMyReferralCode = void 0;
const zod_1 = require("zod");
const node_crypto_1 = __importDefault(require("node:crypto"));
const User_1 = require("../models/User");
const Referral_1 = require("../models/Referral");
const ApiError_1 = require("../utils/ApiError");
const asyncHandler_1 = require("../utils/asyncHandler");
const coin_service_1 = require("../services/coins/coin.service");
const logger_1 = require("../utils/logger");
const REFEREE_COIN_AMOUNT = 20;
const REFERRER_COIN_AMOUNT = 30;
const REFERRER_DAILY_CAP = 10 * REFERRER_COIN_AMOUNT;
const CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const generateCode = () => {
    const bytes = node_crypto_1.default.randomBytes(CODE_LENGTH);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) {
        out += CODE_CHARSET[bytes[i] % CODE_CHARSET.length];
    }
    return out;
};
exports.getMyReferralCode = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const existing = await User_1.User.findById(req.user._id).select('referralCode');
    if (!existing)
        throw ApiError_1.ApiError.notFound('User not found');
    if (existing.referralCode) {
        res.json({ success: true, data: { code: existing.referralCode } });
        return;
    }
    let attempt = 0;
    while (attempt < 5) {
        attempt += 1;
        const candidate = generateCode();
        try {
            const updated = await User_1.User.findOneAndUpdate({ _id: req.user._id, referralCode: { $exists: false } }, { $set: { referralCode: candidate } }, { new: true, projection: { referralCode: 1 } });
            if (updated?.referralCode) {
                res.json({ success: true, data: { code: updated.referralCode } });
                return;
            }
            const reread = await User_1.User.findById(req.user._id).select('referralCode');
            if (reread?.referralCode) {
                res.json({ success: true, data: { code: reread.referralCode } });
                return;
            }
        }
        catch (err) {
            if (!(err &&
                typeof err === 'object' &&
                'code' in err &&
                err.code === 11000)) {
                throw err;
            }
        }
    }
    throw ApiError_1.ApiError.internal('Could not allocate a referral code');
});
exports.claimReferralSchema = zod_1.z.object({
    body: zod_1.z.object({
        code: zod_1.z
            .string()
            .min(4)
            .max(12)
            .transform((s) => s.trim().toUpperCase()),
    }),
});
exports.claimReferral = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { code } = req.body;
    const referrer = await User_1.User.findOne({ referralCode: code }).select('_id');
    if (!referrer)
        throw ApiError_1.ApiError.notFound('Invalid referral code');
    if (referrer._id.equals(req.user._id)) {
        throw ApiError_1.ApiError.badRequest("You can't refer yourself");
    }
    const existing = await Referral_1.Referral.findOne({ referee: req.user._id }).lean();
    if (existing)
        throw ApiError_1.ApiError.conflict('Referral code already claimed');
    let referral;
    try {
        referral = await Referral_1.Referral.create({
            referrer: referrer._id,
            referee: req.user._id,
            codeUsed: code,
            refereeAmount: REFEREE_COIN_AMOUNT,
            referrerAmount: REFERRER_COIN_AMOUNT,
        });
    }
    catch (err) {
        if (err &&
            typeof err === 'object' &&
            'code' in err &&
            err.code === 11000) {
            throw ApiError_1.ApiError.conflict('Referral code already claimed');
        }
        throw err;
    }
    const refereeGrant = await (0, coin_service_1.grantCoins)({
        user: req.user.id,
        amount: REFEREE_COIN_AMOUNT,
        source: 'referral_install',
        idempotencyKey: `referee:${referral._id.toString()}`,
        sourceRefId: referral._id.toString(),
    });
    const referrerGrant = await (0, coin_service_1.grantCoins)({
        user: referrer._id,
        amount: REFERRER_COIN_AMOUNT,
        source: 'referral_share',
        idempotencyKey: `referrer:${referral._id.toString()}`,
        sourceRefId: referral._id.toString(),
        dailyCap: REFERRER_DAILY_CAP,
    });
    if (!refereeGrant.granted) {
        logger_1.logger.warn(`Referee grant failed for referral ${referral._id}: ${refereeGrant.reason}`);
    }
    if (!referrerGrant.granted) {
        logger_1.logger.warn(`Referrer grant failed for referral ${referral._id}: ${referrerGrant.reason}`);
    }
    res.status(201).json({
        success: true,
        message: 'Referral claimed',
        data: {
            coinsAwarded: refereeGrant.amount,
            coinsBalance: refereeGrant.balance,
        },
    });
});
