"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.maybeGrantProfileCompleteBonus = exports.getBalance = exports.grantCoins = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const User_1 = require("../../models/User");
const CoinLedger_1 = require("../../models/CoinLedger");
const logger_1 = require("../../utils/logger");
const completeness_service_1 = require("../profile/completeness.service");
const PROFILE_COMPLETE_COIN_AMOUNT = 50;
const PROFILE_COMPLETE_KEY = 'profile_complete:v1';
const startOfToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
};
const sumTodayForSource = async (userId, source) => {
    const since = startOfToday();
    const agg = await CoinLedger_1.CoinLedger.aggregate([
        {
            $match: {
                user: userId,
                source,
                amount: { $gt: 0 },
                createdAt: { $gte: since },
            },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return agg[0]?.total ?? 0;
};
const grantCoins = async (input) => {
    const { user, source, idempotencyKey, sourceRefId, meta, dailyCap } = input;
    let { amount } = input;
    if (!Number.isFinite(amount) || amount === 0) {
        return { granted: false, amount: 0, balance: 0, reason: 'invalid_amount' };
    }
    const userId = typeof user === 'string' ? new mongoose_1.default.Types.ObjectId(user) : user;
    const userDoc = await User_1.User.findById(userId).select('gamification.coins');
    if (!userDoc) {
        return { granted: false, amount: 0, balance: 0, reason: 'user_not_found' };
    }
    if (dailyCap && dailyCap > 0 && amount > 0) {
        const earnedToday = await sumTodayForSource(userId, source);
        const remaining = dailyCap - earnedToday;
        if (remaining <= 0) {
            return {
                granted: false,
                amount: 0,
                balance: userDoc.gamification?.coins ?? 0,
                reason: 'daily_cap',
            };
        }
        if (remaining < amount)
            amount = remaining;
    }
    const provisionalBalance = Math.max(0, (userDoc.gamification?.coins ?? 0) + amount);
    let ledgerId;
    try {
        const ledger = await CoinLedger_1.CoinLedger.create({
            user: userId,
            amount,
            source,
            idempotencyKey,
            sourceRefId,
            balanceAfter: provisionalBalance,
            meta,
        });
        ledgerId = ledger._id;
    }
    catch (err) {
        if (err &&
            typeof err === 'object' &&
            'code' in err &&
            err.code === 11000) {
            return {
                granted: false,
                amount: 0,
                balance: userDoc.gamification?.coins ?? 0,
                reason: 'duplicate',
            };
        }
        throw err;
    }
    const updated = await User_1.User.findOneAndUpdate({
        _id: userId,
        ...(amount < 0 ? { 'gamification.coins': { $gte: -amount } } : {}),
    }, { $inc: { 'gamification.coins': amount } }, { new: true, projection: { 'gamification.coins': 1 } });
    if (!updated) {
        await CoinLedger_1.CoinLedger.deleteOne({ _id: ledgerId });
        return {
            granted: false,
            amount: 0,
            balance: userDoc.gamification?.coins ?? 0,
            reason: 'invalid_amount',
        };
    }
    const finalBalance = updated.gamification?.coins ?? provisionalBalance;
    if (finalBalance !== provisionalBalance) {
        await CoinLedger_1.CoinLedger.updateOne({ _id: ledgerId }, { $set: { balanceAfter: finalBalance } }).catch((e) => logger_1.logger.warn('Coin ledger snapshot patch failed', e));
    }
    return { granted: true, amount, balance: finalBalance };
};
exports.grantCoins = grantCoins;
const getBalance = async (userId) => {
    const u = await User_1.User.findById(userId).select('gamification.coins').lean();
    return u?.gamification?.coins ?? 0;
};
exports.getBalance = getBalance;
const maybeGrantProfileCompleteBonus = async (user) => {
    const completeness = (0, completeness_service_1.completenessFromUser)(user);
    if (completeness < 100)
        return null;
    return (0, exports.grantCoins)({
        user: user._id,
        amount: PROFILE_COMPLETE_COIN_AMOUNT,
        source: 'resume_complete',
        idempotencyKey: PROFILE_COMPLETE_KEY,
        meta: { completeness },
    });
};
exports.maybeGrantProfileCompleteBonus = maybeGrantProfileCompleteBonus;
