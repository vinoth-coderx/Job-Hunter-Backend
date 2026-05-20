"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiFeedbackSamplesEndpoint = exports.aiFeedbackSamplesSchema = exports.aiCostForecastEndpoint = exports.aiCostForecastSchema = exports.updateCreditWeights = exports.updateCreditWeightsSchema = exports.aiAnalyticsOverview = exports.aiAnalyticsSchema = void 0;
const zod_1 = require("zod");
const asyncHandler_1 = require("../utils/asyncHandler");
const usageLog_service_1 = require("../services/ai/usageLog.service");
const aiCreditWeights_1 = require("../config/aiCreditWeights");
const config_service_1 = require("../services/config/config.service");
const ApiError_1 = require("../utils/ApiError");
const costForecast_service_1 = require("../services/ai/costForecast.service");
const rangeSchema = zod_1.z.object({
    query: zod_1.z.object({
        from: zod_1.z.string().optional(),
        to: zod_1.z.string().optional(),
        days: zod_1.z.coerce.number().int().min(1).max(90).optional(),
        topUsers: zod_1.z.coerce.number().int().min(1).max(100).optional(),
    }),
});
exports.aiAnalyticsSchema = rangeSchema;
exports.aiAnalyticsOverview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { from, to, days, topUsers } = req.query;
    const range = { fromIso: from, toIso: to };
    const [totals, features, providers, series, users, feedback] = await Promise.all([
        (0, usageLog_service_1.getTotals)(range),
        (0, usageLog_service_1.getFeatureBreakdown)(range),
        (0, usageLog_service_1.getProviderBreakdown)(range),
        (0, usageLog_service_1.getDailySeries)(range, days ?? 14),
        (0, usageLog_service_1.getTopUsers)(range, topUsers ?? 20),
        (0, usageLog_service_1.getFeatureFeedback)(range),
    ]);
    const featuresWithWeight = features.map((f) => ({
        ...f,
        creditWeight: (0, aiCreditWeights_1.getCreditWeight)(f.feature),
    }));
    res.json({
        success: true,
        data: {
            range: {
                from: from ?? null,
                to: to ?? null,
            },
            totals,
            features: featuresWithWeight,
            providers,
            series,
            topUsers: users,
            feedback,
            creditWeights: {
                defaults: (0, aiCreditWeights_1.getDefaultWeights)(),
                overrides: (0, aiCreditWeights_1.getCurrentOverrides)(),
            },
        },
    });
});
exports.updateCreditWeightsSchema = zod_1.z.object({
    body: zod_1.z.object({
        overrides: zod_1.z.record(zod_1.z.string().min(1).max(60), zod_1.z.number().int().min(0).max(50)),
    }),
});
exports.updateCreditWeights = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user?._id)
        throw ApiError_1.ApiError.unauthorized();
    const { overrides } = req.body;
    const serialized = (0, aiCreditWeights_1.serializeOverridesForConfig)(overrides);
    await (0, config_service_1.setAppConfig)({
        key: 'AI_CREDIT_WEIGHTS_JSON',
        category: 'misc',
        value: serialized,
        isSecret: false,
        notes: 'Per-feature AI quota weight overrides (admin-edited).',
        updatedBy: String(req.user._id),
    });
    res.json({
        success: true,
        data: {
            defaults: (0, aiCreditWeights_1.getDefaultWeights)(),
            overrides: (0, aiCreditWeights_1.getCurrentOverrides)(),
        },
    });
});
exports.aiCostForecastSchema = zod_1.z.object({
    query: zod_1.z.object({
        windowDays: zod_1.z.coerce.number().int().min(7).max(60).optional(),
    }),
});
exports.aiCostForecastEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { windowDays } = req.query;
    const forecast = await (0, costForecast_service_1.getCostForecast)(windowDays ?? 14);
    res.json({ success: true, data: forecast });
});
exports.aiFeedbackSamplesSchema = zod_1.z.object({
    query: zod_1.z.object({
        feature: zod_1.z.string().min(1).max(60),
        rating: zod_1.z.enum(['down', 'up', 'all']).optional(),
        limit: zod_1.z.coerce.number().int().min(1).max(200).optional(),
        from: zod_1.z.string().optional(),
        to: zod_1.z.string().optional(),
    }),
});
exports.aiFeedbackSamplesEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { feature, rating, limit, from, to } = req.query;
    const samples = await (0, usageLog_service_1.getFeatureFeedbackSamples)(feature, {
        rating: rating ?? 'down',
        limit: limit ?? 50,
        range: { fromIso: from, toIso: to },
    });
    res.json({
        success: true,
        data: {
            feature,
            rating: rating ?? 'down',
            samples,
        },
    });
});
