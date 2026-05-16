import mongoose from 'mongoose';
import { AiUsageLog, type AiUsageProvider, type AiUsageTier } from '../../models/AiUsageLog';
import { AiFeedback } from '../../models/AiFeedback';
import { logger } from '../../utils/logger';

/**
 * USD per 1M tokens at paid-tier list price (free tier is effectively
 * billed against the daily quota, not dollars). Used to render the
 * admin "estimated cost" widget — it's a forecast, not an invoice.
 *
 * Update these when providers change their pricing.
 */
const PRICE_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
  'gemini:lite': { input: 0.10, output: 0.40 },   // 2.5 Flash-Lite
  'gemini:smart': { input: 0.30, output: 2.50 },  // 2.5 Flash
  'claude:lite': { input: 1.00, output: 5.00 },   // Haiku 4.5
  'claude:smart': { input: 3.00, output: 15.00 }, // Sonnet 4.6
  'groq:lite': { input: 0.05, output: 0.08 },     // Llama 3.1 8B Instant
  'groq:smart': { input: 0.59, output: 0.79 },    // Llama 3.3 70B Versatile
};

const estimateCostUsd = (
  provider: AiUsageProvider,
  tier: AiUsageTier,
  inputTokens: number,
  outputTokens: number,
): number => {
  const price = PRICE_PER_M_TOKENS[`${provider}:${tier}`];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
};

export interface RecordUsageArgs {
  userId?: string;
  feature: string;
  provider: AiUsageProvider;
  tier: AiUsageTier;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
  cacheHit?: boolean;
}

/**
 * Fire-and-forget write of one AI call. Never throws — failures here
 * must not break the request path. Called from providers/index.ts so
 * every AI generation is captured uniformly.
 */
export const recordAiUsage = (args: RecordUsageArgs): void => {
  void (async () => {
    try {
      const inTok = Math.max(0, args.inputTokens ?? 0);
      const outTok = Math.max(0, args.outputTokens ?? 0);
      await AiUsageLog.create({
        user: args.userId && mongoose.isValidObjectId(args.userId) ? args.userId : undefined,
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
    } catch (err) {
      logger.warn(`recordAiUsage failed: ${(err as Error).message}`);
    }
  })();
};

// ─── Aggregation helpers (admin analytics dashboard) ────────────────

export interface AnalyticsRange {
  fromIso?: string;
  toIso?: string;
}

const buildMatch = (range: AnalyticsRange): Record<string, unknown> => {
  const match: Record<string, unknown> = {};
  if (range.fromIso || range.toIso) {
    const createdAt: Record<string, Date> = {};
    if (range.fromIso) createdAt.$gte = new Date(range.fromIso);
    if (range.toIso) createdAt.$lte = new Date(range.toIso);
    match.createdAt = createdAt;
  }
  return match;
};

export interface AnalyticsTotals {
  totalCalls: number;
  successCalls: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  avgLatencyMs: number;
}

export const getTotals = async (range: AnalyticsRange): Promise<AnalyticsTotals> => {
  const [row] = await AiUsageLog.aggregate<AnalyticsTotals & { _id: null }>([
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
  return (
    row ?? {
      totalCalls: 0,
      successCalls: 0,
      cacheHits: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      avgLatencyMs: 0,
    }
  );
};

export interface FeatureBreakdownRow {
  feature: string;
  calls: number;
  cacheHits: number;
  totalTokens: number;
  estimatedCostUsd: number;
  avgLatencyMs: number;
}

export const getFeatureBreakdown = async (
  range: AnalyticsRange,
): Promise<FeatureBreakdownRow[]> => {
  const rows = await AiUsageLog.aggregate<{
    _id: string;
    calls: number;
    cacheHits: number;
    totalTokens: number;
    estimatedCostUsd: number;
    avgLatencyMs: number;
  }>([
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

export interface ProviderBreakdownRow {
  provider: AiUsageProvider;
  calls: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export const getProviderBreakdown = async (
  range: AnalyticsRange,
): Promise<ProviderBreakdownRow[]> => {
  const rows = await AiUsageLog.aggregate<{
    _id: AiUsageProvider;
    calls: number;
    totalTokens: number;
    estimatedCostUsd: number;
  }>([
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

export interface DailySeriesPoint {
  date: string; // YYYY-MM-DD (UTC bucket)
  calls: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export const getDailySeries = async (
  range: AnalyticsRange,
  days = 14,
): Promise<DailySeriesPoint[]> => {
  const fromDefault = new Date(Date.now() - days * 86_400_000);
  const match = buildMatch({
    fromIso: range.fromIso ?? fromDefault.toISOString(),
    toIso: range.toIso,
  });
  const rows = await AiUsageLog.aggregate<{
    _id: string;
    calls: number;
    totalTokens: number;
    estimatedCostUsd: number;
  }>([
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

export interface TopUserRow {
  userId: string;
  calls: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export const getTopUsers = async (
  range: AnalyticsRange,
  limit = 20,
): Promise<TopUserRow[]> => {
  const rows = await AiUsageLog.aggregate<{
    _id: mongoose.Types.ObjectId;
    calls: number;
    totalTokens: number;
    estimatedCostUsd: number;
  }>([
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

// ─── Per-user history (Flutter "my AI usage" page) ───────────────────

export interface UserUsageRow {
  feature: string;
  provider: AiUsageProvider;
  totalTokens: number;
  estimatedCostUsd: number;
  cacheHit: boolean;
  createdAt: Date;
}

export const getRecentUsageForUser = async (
  userId: string,
  limit = 50,
): Promise<UserUsageRow[]> => {
  const docs = await AiUsageLog.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(200, limit)))
    .select(
      'feature provider totalTokens estimatedCostUsd cacheHit createdAt',
    )
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

// ─── User feedback aggregation (powers admin "satisfaction" panel) ───

export interface FeatureFeedbackRow {
  feature: string;
  thumbsUp: number;
  thumbsDown: number;
  total: number;
  /** Net score = (up - down) / total. -1.0 (all bad) → 1.0 (all good). */
  netScore: number;
}

/**
 * Per-feature thumbs-up vs thumbs-down breakdown across all users.
 * Powers the admin "AI satisfaction" panel — sort by negative
 * netScore to spot features that need prompt tuning.
 *
 * Range filter respected via `createdAt` so the panel can show
 * "last 7 days" alongside cost / latency in the same window.
 */
export const getFeatureFeedback = async (
  range: AnalyticsRange,
): Promise<FeatureFeedbackRow[]> => {
  const match: Record<string, unknown> = {};
  if (range.fromIso || range.toIso) {
    const createdAt: Record<string, Date> = {};
    if (range.fromIso) createdAt.$gte = new Date(range.fromIso);
    if (range.toIso) createdAt.$lte = new Date(range.toIso);
    match.createdAt = createdAt;
  }
  // Drop neutral (rating=0) rows from the aggregate — they were
  // explicit un-rates and shouldn't dilute the satisfaction signal.
  match.rating = { $in: [-1, 1] };

  const rows = await AiFeedback.aggregate<{
    _id: string;
    thumbsUp: number;
    thumbsDown: number;
  }>([
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

export interface FeedbackSampleRow {
  id: string;
  rating: -1 | 0 | 1;
  note: string;
  refId: string;
  userId: string;
  createdAt: Date;
}

/**
 * Recent feedback rows for a single feature — used by the admin
 * drill-down ("click a feature → see what users actually wrote"). By
 * default returns thumbs-down only; pass `rating='all'` to include
 * thumbs-up notes too. Sorted newest-first.
 */
export const getFeatureFeedbackSamples = async (
  feature: string,
  options: {
    rating?: 'down' | 'up' | 'all';
    limit?: number;
    range?: AnalyticsRange;
  } = {},
): Promise<FeedbackSampleRow[]> => {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const ratingFilter =
    options.rating === 'up'
      ? { $in: [1] }
      : options.rating === 'all'
        ? { $in: [-1, 1] }
        : { $in: [-1] };
  const match: Record<string, unknown> = {
    feature,
    rating: ratingFilter,
  };
  if (options.range?.fromIso || options.range?.toIso) {
    const createdAt: Record<string, Date> = {};
    if (options.range.fromIso) createdAt.$gte = new Date(options.range.fromIso);
    if (options.range.toIso) createdAt.$lte = new Date(options.range.toIso);
    match.createdAt = createdAt;
  }
  const rows = await AiFeedback.find(match)
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
