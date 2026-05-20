"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refundQuota = exports.enforceQuota = exports.getQuotaSnapshot = void 0;
const redis_1 = require("../../config/redis");
const constants_1 = require("../../config/constants");
const ApiError_1 = require("../../utils/ApiError");
const logger_1 = require("../../utils/logger");
const User_1 = require("../../models/User");
const ymdInTz = (tz, d = new Date()) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
    const m = parts.find((p) => p.type === 'month')?.value ?? '00';
    const day = parts.find((p) => p.type === 'day')?.value ?? '00';
    return `${y}-${m}-${day}`;
};
const nextIstMidnightUtc = (now = new Date()) => {
    const IST_OFFSET_MIN = 330;
    const istNowMs = now.getTime() + IST_OFFSET_MIN * 60_000;
    const istNow = new Date(istNowMs);
    const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + 1, 0, 0, 0, 0);
    return new Date(istMidnight - IST_OFFSET_MIN * 60_000);
};
const userKey = (userId, date) => `ai:q:u:${userId}:${date}`;
const globalKey = (date) => `ai:q:g:${date}`;
const ttlSecondsUntilReset = (now = new Date()) => {
    const diffMs = nextIstMidnightUtc(now).getTime() - now.getTime();
    return Math.max(60, Math.ceil(diffMs / 1000));
};
const buildSnapshot = (userUsed, globalUsed, now = new Date()) => {
    const reset = nextIstMidnightUtc(now);
    return {
        userUsed,
        userLimit: constants_1.AI_QUOTA_PER_USER_PER_DAY,
        userRemaining: Math.max(0, constants_1.AI_QUOTA_PER_USER_PER_DAY - userUsed),
        globalUsed,
        globalLimit: constants_1.AI_QUOTA_GLOBAL_PER_DAY,
        globalRemaining: Math.max(0, constants_1.AI_QUOTA_GLOBAL_PER_DAY - globalUsed),
        resetsAtIso: reset.toISOString(),
        resetsInSec: Math.max(0, Math.floor((reset.getTime() - now.getTime()) / 1000)),
    };
};
const getQuotaSnapshot = async (userId) => {
    const date = ymdInTz(constants_1.AI_QUOTA_TIMEZONE);
    const [userRaw, globalRaw] = await redis_1.redis.mget(userKey(userId, date), globalKey(date));
    const snap = buildSnapshot(Number(userRaw) || 0, Number(globalRaw) || 0);
    try {
        const user = await User_1.User.findById(userId).select('aiTopUpCredits').lean();
        snap.topUpCredits = Math.max(0, Number(user?.aiTopUpCredits ?? 0));
    }
    catch {
        snap.topUpCredits = 0;
    }
    return snap;
};
exports.getQuotaSnapshot = getQuotaSnapshot;
const tryDebitTopUp = async (userId, weight) => {
    if (weight <= 0)
        return null;
    try {
        const updated = await User_1.User.findOneAndUpdate({ _id: userId, aiTopUpCredits: { $gte: weight } }, { $inc: { aiTopUpCredits: -weight } }, { new: true, projection: { aiTopUpCredits: 1 } }).lean();
        if (!updated)
            return null;
        return Math.max(0, Number(updated.aiTopUpCredits ?? 0));
    }
    catch (err) {
        logger_1.logger.warn(`tryDebitTopUp failed: ${err.message}`);
        return null;
    }
};
const refundTopUp = async (userId, weight) => {
    if (weight <= 0)
        return;
    try {
        await User_1.User.updateOne({ _id: userId }, { $inc: { aiTopUpCredits: weight } });
    }
    catch (err) {
        logger_1.logger.warn(`refundTopUp failed: ${err.message}`);
    }
};
const enforceQuota = async (userId, weight = 1) => {
    if (weight <= 0)
        return (0, exports.getQuotaSnapshot)(userId);
    const now = new Date();
    const date = ymdInTz(constants_1.AI_QUOTA_TIMEZONE, now);
    const ttl = ttlSecondsUntilReset(now);
    const uKey = userKey(userId, date);
    const gKey = globalKey(date);
    const [userRaw, globalRaw] = await redis_1.redis.mget(uKey, gKey);
    const userUsed = Number(userRaw) || 0;
    const globalUsed = Number(globalRaw) || 0;
    if (globalUsed + weight > constants_1.AI_QUOTA_GLOBAL_PER_DAY) {
        const snap = buildSnapshot(userUsed, globalUsed, now);
        throw new ApiError_1.ApiError(429, 'AI free tier daily limit reached for the platform', {
            quota: snap,
            reason: 'global',
        });
    }
    if (userUsed + weight <= constants_1.AI_QUOTA_PER_USER_PER_DAY) {
        const pipe = redis_1.redis.multi();
        pipe.incrby(uKey, weight);
        pipe.expire(uKey, ttl, 'NX');
        pipe.incrby(gKey, weight);
        pipe.expire(gKey, ttl, 'NX');
        const result = await pipe.exec();
        const newUserUsed = result && result[0] && typeof result[0][1] === 'number'
            ? result[0][1]
            : userUsed + weight;
        const newGlobalUsed = result && result[2] && typeof result[2][1] === 'number'
            ? result[2][1]
            : globalUsed + weight;
        const snap = buildSnapshot(newUserUsed, newGlobalUsed, now);
        try {
            const u = await User_1.User.findById(userId).select('aiTopUpCredits').lean();
            snap.topUpCredits = Math.max(0, Number(u?.aiTopUpCredits ?? 0));
        }
        catch {
        }
        return snap;
    }
    const newPackBalance = await tryDebitTopUp(userId, weight);
    if (newPackBalance !== null) {
        const pipe = redis_1.redis.multi();
        pipe.incrby(gKey, weight);
        pipe.expire(gKey, ttl, 'NX');
        const result = await pipe.exec();
        const newGlobalUsed = result && result[0] && typeof result[0][1] === 'number'
            ? result[0][1]
            : globalUsed + weight;
        const snap = buildSnapshot(userUsed, newGlobalUsed, now);
        snap.topUpCredits = newPackBalance;
        return snap;
    }
    const snap = buildSnapshot(userUsed, globalUsed, now);
    try {
        const u = await User_1.User.findById(userId).select('aiTopUpCredits').lean();
        snap.topUpCredits = Math.max(0, Number(u?.aiTopUpCredits ?? 0));
    }
    catch {
        snap.topUpCredits = 0;
    }
    throw new ApiError_1.ApiError(429, 'You have used today\'s AI quota', {
        quota: snap,
        reason: 'user',
    });
};
exports.enforceQuota = enforceQuota;
const refundQuota = async (userId, weight = 1) => {
    if (weight <= 0)
        return;
    try {
        const date = ymdInTz(constants_1.AI_QUOTA_TIMEZONE);
        const uKey = userKey(userId, date);
        const userUsed = Number(await redis_1.redis.get(uKey)) || 0;
        if (userUsed >= weight) {
            await redis_1.redis
                .multi()
                .decrby(uKey, weight)
                .decrby(globalKey(date), weight)
                .exec();
        }
        else {
            await refundTopUp(userId, weight);
            await redis_1.redis.decrby(globalKey(date), weight);
        }
    }
    catch (err) {
        logger_1.logger.warn(`refundQuota failed: ${err.message}`);
    }
};
exports.refundQuota = refundQuota;
