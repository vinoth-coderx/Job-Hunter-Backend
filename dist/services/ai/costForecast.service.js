"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCostForecast = void 0;
const AiUsageLog_1 = require("../../models/AiUsageLog");
const ymd = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};
const getCostForecast = async (windowDays = 14) => {
    const from = new Date(Date.now() - windowDays * 86_400_000);
    const rows = await AiUsageLog_1.AiUsageLog.aggregate([
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
    const recent = rows.map((r) => ({
        date: r._id,
        costUsd: Number(r.costUsd.toFixed(6)),
        calls: r.calls,
        tokens: r.tokens,
    }));
    const today = ymd(new Date());
    const completedDays = recent.filter((r) => r.date !== today);
    const trailingDailyAvgUsd = completedDays.length === 0
        ? 0
        : completedDays.reduce((s, r) => s + r.costUsd, 0) /
            completedDays.length;
    const highest = recent.reduce((best, r) => (best === null || r.costUsd > best.costUsd ? r : best), null);
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
exports.getCostForecast = getCostForecast;
