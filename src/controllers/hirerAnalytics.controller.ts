import { Response } from 'express';
import mongoose from 'mongoose';
import { HirerProfile } from '../models/HirerProfile';
import { Job } from '../models/Job';
import { AppliedJob } from '../models/AppliedJob';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import {
  generateHirerDigest,
  peekCachedDigest,
} from '../services/ai/hirerDigest.service';
import {
  enforceQuota,
  getQuotaSnapshot,
  refundQuota,
} from '../services/ai/quota.service';
import { getCreditWeight } from '../config/aiCreditWeights';
import { buildHirerAttention } from '../services/hirer/attention.service';

const requireHirerProfile = async (userId: string) => {
  const profile = await HirerProfile.findOne({ user: userId });
  if (!profile) throw ApiError.forbidden('Set up a company profile first');
  return profile;
};

interface FunnelBucket {
  status: string;
  count: number;
}

/**
 * Roll-up of applications across all native jobs the hirer owns.
 *   - funnel:        count per AppliedJob status
 *   - sourceBreakdown: count per applyType (native/auto_apply/external_manual)
 *   - topJobs:       top 5 jobs by applicationsCount
 *   - timeToHire:    avg days from appliedAt → hired statusHistory entry
 *   - daily30:       last-30-day timeseries of applications received
 */
export const getHirerAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);

  // List my native jobs first — every aggregation that follows scopes
  // by these.
  const myJobs = await Job.find({
    hirerProfile: profile._id,
    isNative: true,
  })
    .select('_id title applicationsCount shortlistedCount publishedAt status')
    .lean();

  if (myJobs.length === 0) {
    res.json({
      success: true,
      data: {
        totalJobs: 0,
        totalApplications: 0,
        funnel: [],
        sourceBreakdown: [],
        topJobs: [],
        timeToHireDays: null,
        daily30: [],
      },
    });
    return;
  }

  const jobIds = myJobs.map((j) => j._id);

  // 1. Funnel by current status.
  const funnelAgg = await AppliedJob.aggregate<{ _id: string; count: number }>([
    { $match: { job: { $in: jobIds } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const FUNNEL_ORDER = [
    'applied',
    'viewed',
    'shortlisted',
    'interview',
    'offer',
    'hired',
    'rejected',
    'withdrawn',
  ];
  const funnelMap = new Map(funnelAgg.map((b) => [b._id, b.count]));
  const funnel: FunnelBucket[] = FUNNEL_ORDER.map((s) => ({
    status: s,
    count: funnelMap.get(s) ?? 0,
  }));

  // 2. Source breakdown (applyType).
  const sourceAgg = await AppliedJob.aggregate<{ _id: string; count: number }>([
    { $match: { job: { $in: jobIds } } },
    { $group: { _id: '$applyType', count: { $sum: 1 } } },
  ]);
  const sourceBreakdown = sourceAgg
    .map((b) => ({ source: b._id, count: b.count }))
    .sort((a, b) => b.count - a.count);

  // 3. Top jobs by applicant count.
  const topJobs = [...myJobs]
    .sort((a, b) => (b.applicationsCount ?? 0) - (a.applicationsCount ?? 0))
    .slice(0, 5)
    .map((j) => ({
      jobId: j._id.toString(),
      title: j.title,
      applicationsCount: j.applicationsCount ?? 0,
      shortlistedCount: j.shortlistedCount ?? 0,
      status: j.status,
    }));

  // 4. Time-to-hire — pull from statusHistory, compute applied → hired delta.
  const hired = await AppliedJob.find({
    job: { $in: jobIds },
    status: 'hired',
  })
    .select('appliedAt statusHistory')
    .lean();

  let timeToHireDays: number | null = null;
  if (hired.length > 0) {
    const deltas: number[] = [];
    for (const h of hired) {
      const hiredEntry = h.statusHistory?.find((s) => s.status === 'hired');
      const at = hiredEntry?.changedAt ?? null;
      if (!at) continue;
      const ms = new Date(at).getTime() - new Date(h.appliedAt).getTime();
      if (ms > 0) deltas.push(ms / (1000 * 60 * 60 * 24));
    }
    if (deltas.length > 0) {
      timeToHireDays = Math.round(
        deltas.reduce((s, n) => s + n, 0) / deltas.length,
      );
    }
  }

  // 5. Daily timeseries — last 30 days, applications grouped by day.
  const since = new Date();
  since.setDate(since.getDate() - 29);
  since.setHours(0, 0, 0, 0);

  const daily = await AppliedJob.aggregate<{ _id: string; count: number }>([
    {
      $match: {
        job: { $in: jobIds },
        appliedAt: { $gte: since },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: '%Y-%m-%d', date: '$appliedAt' },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  // Fill missing days with zero so the chart is even.
  const dailyMap = new Map(daily.map((d) => [d._id, d.count]));
  const daily30: { date: string; count: number }[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    daily30.push({ date: key, count: dailyMap.get(key) ?? 0 });
  }

  const totalApplications = funnel.reduce((s, b) => s + b.count, 0);

  res.json({
    success: true,
    data: {
      totalJobs: myJobs.length,
      totalApplications,
      funnel,
      sourceBreakdown,
      topJobs,
      timeToHireDays,
      daily30,
    },
  });
});

/**
 * AI weekly digest for the hirer dashboard. Same-day cache means the
 * first dashboard visit of the day generates it; everyone else (and
 * subsequent refreshes) hit cache. Weight 1 — small Groq call.
 */
export const getHirerDigestEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);
    const profile = await requireHirerProfile(req.user.id);

    const cached = await peekCachedDigest(profile._id.toString());
    let quota = await getQuotaSnapshot(userId);
    if (cached) {
      res.json({
        success: true,
        data: { ...cached, cached: true },
        quota,
      });
      return;
    }

    const weight = getCreditWeight('hirer_digest');
    if (weight > 0) quota = await enforceQuota(userId, weight);

    let result;
    try {
      result = await generateHirerDigest({
        hirerProfileId: profile._id,
        userId,
      });
    } catch (err) {
      if (weight > 0) await refundQuota(userId, weight);
      throw err;
    }
    if (weight > 0 && !result.usedAi) {
      await refundQuota(userId, weight);
    }

    res.json({ success: true, data: result, quota });
  },
);

/**
 * "Needs attention" snapshot — the four pipeline blockers a hirer
 * should action when they land. Pure data aggregation, no AI cost.
 */
export const getHirerAttentionEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const data = await buildHirerAttention(profile._id);
    res.json({ success: true, data });
  },
);
