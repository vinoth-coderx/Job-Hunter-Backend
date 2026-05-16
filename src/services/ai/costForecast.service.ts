import { AiUsageLog } from '../../models/AiUsageLog';

/**
 * AI cost forecast. Looks at recent daily spend and projects the next
 * 7 and 30 days using a simple trailing average — good enough to spot
 * a runaway feature without bringing in a stats lib. Used by:
 *   - admin AI analytics page "Forecast" card
 *   - daily cron that emails when projected spend crosses the alert
 *     threshold (AI_COST_ALERT_USD_30D, default 25.00)
 */

export interface DailyCostPoint {
  date: string;
  costUsd: number;
  calls: number;
  tokens: number;
}

export interface CostForecast {
  windowDays: number;
  recent: DailyCostPoint[];
  trailingDailyAvgUsd: number;
  projection7dUsd: number;
  projection30dUsd: number;
  highestDay: DailyCostPoint | null;
  todayUsd: number;
}

const ymd = (d: Date): string => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const getCostForecast = async (
  windowDays = 14,
): Promise<CostForecast> => {
  const from = new Date(Date.now() - windowDays * 86_400_000);
  const rows = await AiUsageLog.aggregate<{
    _id: string;
    costUsd: number;
    calls: number;
    tokens: number;
  }>([
    { $match: { createdAt: { $gte: from } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        costUsd: { $sum: '$estimatedCostUsd' },
        calls: { $sum: 1 },
        tokens: { $sum: '$totalTokens' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const recent: DailyCostPoint[] = rows.map((r) => ({
    date: r._id,
    costUsd: Number(r.costUsd.toFixed(6)),
    calls: r.calls,
    tokens: r.tokens,
  }));

  // Trailing average excludes today (partial day skews the projection).
  const today = ymd(new Date());
  const completedDays = recent.filter((r) => r.date !== today);
  const trailingDailyAvgUsd =
    completedDays.length === 0
      ? 0
      : completedDays.reduce((s, r) => s + r.costUsd, 0) /
        completedDays.length;

  const highest = recent.reduce<DailyCostPoint | null>(
    (best, r) => (best === null || r.costUsd > best.costUsd ? r : best),
    null,
  );
  const todayPoint = recent.find((r) => r.date === today);

  return {
    windowDays,
    recent,
    trailingDailyAvgUsd: Number(trailingDailyAvgUsd.toFixed(4)),
    projection7dUsd: Number((trailingDailyAvgUsd * 7).toFixed(2)),
    projection30dUsd: Number((trailingDailyAvgUsd * 30).toFixed(2)),
    highestDay: highest,
    todayUsd: Number((todayPoint?.costUsd ?? 0).toFixed(4)),
  };
};
