import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import {
  getDailySeries,
  getFeatureBreakdown,
  getFeatureFeedback,
  getFeatureFeedbackSamples,
  getProviderBreakdown,
  getTopUsers,
  getTotals,
} from '../services/ai/usageLog.service';
import {
  getCreditWeight,
  getCurrentOverrides,
  getDefaultWeights,
  serializeOverridesForConfig,
} from '../config/aiCreditWeights';
import { setAppConfig } from '../services/config/config.service';
import { ApiError } from '../utils/ApiError';
import { getCostForecast } from '../services/ai/costForecast.service';

/**
 * Single-call analytics overview for the admin AI dashboard. Bundles the
 * five aggregations into one round-trip so the page renders without
 * waterfall fetches. All bands honour the optional `from` / `to` query
 * params (ISO strings); when both are omitted we use a default 14-day
 * window for the daily series and unbounded everywhere else.
 */
const rangeSchema = z.object({
  query: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    days: z.coerce.number().int().min(1).max(90).optional(),
    topUsers: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

export const aiAnalyticsSchema = rangeSchema;

export const aiAnalyticsOverview = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const { from, to, days, topUsers } = req.query as z.infer<
      typeof rangeSchema
    >['query'];
    const range = { fromIso: from, toIso: to };
    const [totals, features, providers, series, users, feedback] =
      await Promise.all([
        getTotals(range),
        getFeatureBreakdown(range),
        getProviderBreakdown(range),
        getDailySeries(range, days ?? 14),
        getTopUsers(range, topUsers ?? 20),
        getFeatureFeedback(range),
      ]);

    // Decorate each feature row with its current credit weight so the
    // admin can correlate spend with the per-feature charge. Unknown
    // feature names (legacy entries) fall back to 1, matching the
    // legacy uniform behaviour of `enforceQuota`.
    const featuresWithWeight = features.map((f) => ({
      ...f,
      creditWeight: getCreditWeight(f.feature),
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
          defaults: getDefaultWeights(),
          overrides: getCurrentOverrides(),
        },
      },
    });
  },
);

export const updateCreditWeightsSchema = z.object({
  body: z.object({
    /** Replace the entire overrides map. Pass {} to clear all overrides. */
    overrides: z.record(z.string().min(1).max(60), z.number().int().min(0).max(50)),
  }),
});

/**
 * Replace the credit-weight overrides map. Validation/sanitisation
 * happens in `serializeOverridesForConfig` — anything outside [0, 50]
 * or with a too-long feature name is silently dropped, mirroring the
 * defensive read path so we never surface a stale "I saved that" lie.
 */
export const updateCreditWeights = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user?._id) throw ApiError.unauthorized();
    const { overrides } = req.body as z.infer<
      typeof updateCreditWeightsSchema
    >['body'];

    const serialized = serializeOverridesForConfig(overrides);
    await setAppConfig({
      key: 'AI_CREDIT_WEIGHTS_JSON',
      // No 'ai' category in the config taxonomy yet — bucket under
      // 'misc' so the admin AppConfig page still surfaces this row;
      // the dedicated weights editor is the canonical UI for it.
      category: 'misc',
      value: serialized,
      isSecret: false,
      notes: 'Per-feature AI quota weight overrides (admin-edited).',
      updatedBy: String(req.user._id),
    });

    res.json({
      success: true,
      data: {
        defaults: getDefaultWeights(),
        overrides: getCurrentOverrides(),
      },
    });
  },
);

export const aiCostForecastSchema = z.object({
  query: z.object({
    windowDays: z.coerce.number().int().min(7).max(60).optional(),
  }),
});

/**
 * Forecast endpoint for the admin AI dashboard. Returns the last
 * `windowDays` of daily spend, a 7-day and 30-day projection, and the
 * worst day's burn — enough for the admin to spot a runaway feature
 * before the monthly bill arrives.
 */
export const aiCostForecastEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const { windowDays } = req.query as z.infer<
      typeof aiCostForecastSchema
    >['query'];
    const forecast = await getCostForecast(windowDays ?? 14);
    res.json({ success: true, data: forecast });
  },
);

export const aiFeedbackSamplesSchema = z.object({
  query: z.object({
    feature: z.string().min(1).max(60),
    rating: z.enum(['down', 'up', 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
});

/**
 * Drill-down endpoint for the admin "AI satisfaction" panel. Returns
 * the most recent feedback notes for a single feature so the admin
 * can read what users actually said when they thumbs-downed an output.
 * Defaults to thumbs-down only, newest first, 50 rows.
 */
export const aiFeedbackSamplesEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const { feature, rating, limit, from, to } = req.query as unknown as z.infer<
      typeof aiFeedbackSamplesSchema
    >['query'];
    const samples = await getFeatureFeedbackSamples(feature, {
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
  },
);
