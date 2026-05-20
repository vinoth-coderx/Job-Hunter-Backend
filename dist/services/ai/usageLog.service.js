"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFeatureFeedbackSamples = exports.getFeatureFeedback = exports.getRecentUsageForUser = exports.getTopUsers = exports.getDailySeries = exports.getProviderBreakdown = exports.getFeatureBreakdown = exports.getTotals = exports.recordAiUsage = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const AiUsageLog_1 = require("../../models/AiUsageLog");
const AiFeedback_1 = require("../../models/AiFeedback");
const logger_1 = require("../../utils/logger");
const PRICE_PER_M_TOKENS = {
    'gemini:lite': { input: 0.10, output: 0.40 },
    'gemini:smart': { input: 0.30, output: 2.50 },
    'claude:lite': { input: 1.00, output: 5.00 },
    'claude:smart': { input: 3.00, output: 15.00 },
    'groq:lite': { input: 0.05, output: 0.08 },
    'groq:smart': { input: 0.59, output: 0.79 },
};
const estimateCostUsd = (provider, tier, inputTokens, outputTokens) => {
    const price = PRICE_PER_M_TOKENS[`${provider}:${tier}`];
    if (!price)
        return 0;
    return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
};
const recordAiUsage = (args) => {
    void (async () => {
        try {
            const inTok = Math.max(0, args.inputTokens ?? 0);
            const outTok = Math.max(0, args.outputTokens ?? 0);
            await AiUsageLog_1.AiUsageLog.create({
                user: args.userId && mongoose_1.default.isValidObjectId(args.userId) ? args.userId : undefined,
                feature: args.feature,
                provider: args.provider,
                tier: args.tier,
                inputTokens: inTok,
                outputTokens: outTok,
                totalTokens: inTok + outTok,
                estimatedCostUsd: args.cacheHit
                    ? 0
                    : estimateCostUsd(args.provider, args.tier, inTok, outTok),
                latencyMs: Math.max(0, args.latencyMs),
                success: args.success,
                errorCode: args.errorCode,
                cacheHit: !!args.cacheHit,
            });
        }
        catch (err) {
            logger_1.logger.warn(`recordAiUsage failed: ${err.message}`);
        }
    })();
};
exports.recordAiUsage = recordAiUsage;
const buildMatch = (range) => {
    const match = {};
    if (range.fromIso || range.toIso) {
        const createdAt = {};
        if (range.fromIso)
            createdAt.$gte = new Date(range.fromIso);
        if (range.toIso)
            createdAt.$lte = new Date(range.toIso);
        match.createdAt = createdAt;
    }
    return match;
};
const getTotals = async (range) => {
    const [row] = await AiUsageLog_1.AiUsageLog.aggregate([
        { $match: buildMatch(range) },
        {
            $group: {
                _id: null,
                totalCalls: { $sum: 1 },
                successCalls: { $sum: { $cond: ['$success', 1, 0] } },
                cacheHits: { $sum: { $cond: ['$cacheHit', 1, 0] } },
                inputTokens: { $sum: '$inputTokens' },
                outputTokens: { $sum: '$outputTokens' },
                totalTokens: { $sum: '$totalTokens' },
                estimatedCostUsd: { $sum: '$estimatedCostUsd' },
                avgLatencyMs: { $avg: '$latencyMs' },
            },
        },
    ]);
    return (row ?? {
        totalCalls: 0,
        successCalls: 0,
        cacheHits: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        avgLatencyMs: 0,
    });
};
exports.getTotals = getTotals;
const getFeatureBreakdown = async (range) => {
    const rows = await AiUsageLog_1.AiUsageLog.aggregate([
        { $match: buildMatch(range) },
        {
            $group: {
                _id: '$feature',
                calls: { $sum: 1 },
                cacheHits: { $sum: { $cond: ['$cacheHit', 1, 0] } },
                totalTokens: { $sum: '$totalTokens' },
                estimatedCostUsd: { $sum: '$estimatedCostUsd' },
                avgLatencyMs: { $avg: '$latencyMs' },
            },
        },
        { $sort: { estimatedCostUsd: -1, calls: -1 } },
    ]);
    return rows.map((r) => ({
        feature: r._id,
        calls: r.calls,
        cacheHits: r.cacheHits,
        totalTokens: r.totalTokens,
        estimatedCostUsd: r.estimatedCostUsd,
        avgLatencyMs: r.avgLatencyMs,
    }));
};
exports.getFeatureBreakdown = getFeatureBreakdown;
const getProviderBreakdown = async (range) => {
    const rows = await AiUsageLog_1.AiUsageLog.aggregate([
        { $match: { ...buildMatch(range), cacheHit: false } },
        {
            $group: {
                _id: '$provider',
                calls: { $sum: 1 },
                totalTokens: { $sum: '$totalTokens' },
                estimatedCostUsd: { $sum: '$estimatedCostUsd' },
            },
        },
    ]);
    return rows.map((r) => ({
        provider: r._id,
        calls: r.calls,
        totalTokens: r.totalTokens,
        estimatedCostUsd: r.estimatedCostUsd,
    }));
};
exports.getProviderBreakdown = getProviderBreakdown;
const getDailySeries = async (range, days = 14) => {
    const fromDefault = new Date(Date.now() - days * 86_400_000);
    const match = buildMatch({
        fromIso: range.fromIso ?? fromDefault.toISOString(),
        toIso: range.toIso,
    });
    const rows = await AiUsageLog_1.AiUsageLog.aggregate([
        { $match: match },
        {
            $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                calls: { $sum: 1 },
                totalTokens: { $sum: '$totalTokens' },
                estimatedCostUsd: { $sum: '$estimatedCostUsd' },
            },
        },
        { $sort: { _id: 1 } },
    ]);
    return rows.map((r) => ({
        date: r._id,
        calls: r.calls,
        totalTokens: r.totalTokens,
        estimatedCostUsd: r.estimatedCostUsd,
    }));
};
exports.getDailySeries = getDailySeries;
const getTopUsers = async (range, limit = 20) => {
    const rows = await AiUsageLog_1.AiUsageLog.aggregate([
        { $match: { ...buildMatch(range), user: { $exists: true, $ne: null } } },
        {
            $group: {
                _id: '$user',
                calls: { $sum: 1 },
                totalTokens: { $sum: '$totalTokens' },
                estimatedCostUsd: { $sum: '$estimatedCostUsd' },
            },
        },
        { $sort: { calls: -1 } },
        { $limit: limit },
    ]);
    return rows.map((r) => ({
        userId: r._id.toString(),
        calls: r.calls,
        totalTokens: r.totalTokens,
        estimatedCostUsd: r.estimatedCostUsd,
    }));
};
exports.getTopUsers = getTopUsers;
const getRecentUsageForUser = async (userId, limit = 50) => {
    const docs = await AiUsageLog_1.AiUsageLog.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(Math.max(1, Math.min(200, limit)))
        .select('feature provider totalTokens estimatedCostUsd cacheHit createdAt')
        .lean();
    return docs.map((d) => ({
        feature: d.feature,
        provider: d.provider,
        totalTokens: d.totalTokens,
        estimatedCostUsd: d.estimatedCostUsd,
        cacheHit: d.cacheHit,
        createdAt: d.createdAt,
    }));
};
exports.getRecentUsageForUser = getRecentUsageForUser;
const getFeatureFeedback = async (range) => {
    const match = {};
    if (range.fromIso || range.toIso) {
        const createdAt = {};
        if (range.fromIso)
            createdAt.$gte = new Date(range.fromIso);
        if (range.toIso)
            createdAt.$lte = new Date(range.toIso);
        match.createdAt = createdAt;
    }
    match.rating = { $in: [-1, 1] };
    const rows = await AiFeedback_1.AiFeedback.aggregate([
        { $match: match },
        {
            $group: {
                _id: '$feature',
                thumbsUp: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
                thumbsDown: { $sum: { $cond: [{ $eq: ['$rating', -1] }, 1, 0] } },
            },
        },
        { $sort: { thumbsDown: -1, thumbsUp: -1 } },
    ]);
    return rows.map((r) => {
        const total = r.thumbsUp + r.thumbsDown;
        return {
            feature: r._id,
            thumbsUp: r.thumbsUp,
            thumbsDown: r.thumbsDown,
            total,
            netScore: total > 0 ? (r.thumbsUp - r.thumbsDown) / total : 0,
        };
    });
};
exports.getFeatureFeedback = getFeatureFeedback;
const getFeatureFeedbackSamples = async (feature, options = {}) => {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const ratingFilter = options.rating === 'up'
        ? { $in: [1] }
        : options.rating === 'all'
            ? { $in: [-1, 1] }
            : { $in: [-1] };
    const match = {
        feature,
        rating: ratingFilter,
    };
    if (options.range?.fromIso || options.range?.toIso) {
        const createdAt = {};
        if (options.range.fromIso)
            createdAt.$gte = new Date(options.range.fromIso);
        if (options.range.toIso)
            createdAt.$lte = new Date(options.range.toIso);
        match.createdAt = createdAt;
    }
    const rows = await AiFeedback_1.AiFeedback.find(match)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    return rows.map((r) => ({
        id: String(r._id),
        rating: r.rating,
        note: r.note ?? '',
        refId: r.refId,
        userId: String(r.user),
        createdAt: r.createdAt,
    }));
};
exports.getFeatureFeedbackSamples = getFeatureFeedbackSamples;
