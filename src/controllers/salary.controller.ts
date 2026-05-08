import { Response, Request } from 'express';
import { z } from 'zod';
import { SalarySubmission } from '../models/SalarySubmission';
import { redis } from '../config/redis';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';

const MIN_DATA_POINTS = 5;
const CACHE_TTL_SECONDS = 60 * 60; // 1h

const cacheKey = (role: string, city: string) =>
  `salary:${role.toLowerCase()}:${city.toLowerCase()}`;

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo));
};

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

export const insightsQuerySchema = z.object({
  query: z.object({
    role: z.string().min(2).max(100),
    city: z.string().min(2).max(100),
  }),
});

export const submitSchema = z.object({
  body: z.object({
    role: z.string().min(2).max(100),
    city: z.string().min(2).max(100),
    industry: z.string().max(100).optional(),
    company: z.string().max(200).optional(),
    experienceYears: z.coerce.number().min(0).max(60),
    salaryInr: z.coerce.number().min(50_000).max(50_000_000),
  }),
});

export const compareSchema = z.object({
  body: z.object({
    role: z.string().min(2).max(100),
    city: z.string().min(2).max(100),
    salaryInr: z.coerce.number().min(50_000).max(50_000_000),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────

export const getInsights = asyncHandler(async (req: Request, res: Response) => {
  const { role, city } = req.query as { role: string; city: string };

  const key = cacheKey(role, city);
  const cached = await redis.get(key);
  if (cached) {
    res.json({ success: true, data: JSON.parse(cached), cached: true });
    return;
  }

  const docs = await SalarySubmission.find({
    role: role.toLowerCase(),
    city: city.toLowerCase(),
  })
    .select('salaryInr experienceYears company submittedAt')
    .lean();

  if (docs.length < MIN_DATA_POINTS) {
    res.json({
      success: true,
      data: {
        role,
        city,
        dataPointsCount: docs.length,
        notEnoughData: true,
        minDataPoints: MIN_DATA_POINTS,
      },
    });
    return;
  }

  const salaries = docs.map((d) => d.salaryInr).sort((a, b) => a - b);
  const p10 = percentile(salaries, 10);
  const p25 = percentile(salaries, 25);
  const p50 = percentile(salaries, 50);
  const p75 = percentile(salaries, 75);
  const p90 = percentile(salaries, 90);

  // By-experience band buckets.
  const buckets: Record<string, number[]> = {
    '0-2': [],
    '2-5': [],
    '5-10': [],
    '10+': [],
  };
  for (const d of docs) {
    const y = d.experienceYears;
    if (y < 2) buckets['0-2'].push(d.salaryInr);
    else if (y < 5) buckets['2-5'].push(d.salaryInr);
    else if (y < 10) buckets['5-10'].push(d.salaryInr);
    else buckets['10+'].push(d.salaryInr);
  }
  const byExperience = Object.entries(buckets)
    .filter(([, v]) => v.length > 0)
    .map(([range, v]) => ({
      range,
      average: Math.round(v.reduce((s, n) => s + n, 0) / v.length),
      min: Math.min(...v),
      max: Math.max(...v),
      sampleSize: v.length,
    }));

  // Top 5 companies by mean salary (only when we have ≥3 data points
  // for the company so we don't surface noisy outliers).
  const byCompany = new Map<string, number[]>();
  for (const d of docs) {
    if (!d.company) continue;
    const c = d.company.trim();
    if (!c) continue;
    const arr = byCompany.get(c) ?? [];
    arr.push(d.salaryInr);
    byCompany.set(c, arr);
  }
  const topCompanies = [...byCompany.entries()]
    .filter(([, v]) => v.length >= 3)
    .map(([company, v]) => ({
      companyName: company,
      averageSalary: Math.round(v.reduce((s, n) => s + n, 0) / v.length),
      sampleSize: v.length,
    }))
    .sort((a, b) => b.averageSalary - a.averageSalary)
    .slice(0, 5);

  // Year-over-year trend — compare last 12 months to the prior 12.
  const now = Date.now();
  const recentCutoff = now - 365 * 24 * 60 * 60 * 1000;
  const priorCutoff = now - 2 * 365 * 24 * 60 * 60 * 1000;
  const recent = docs
    .filter((d) => d.submittedAt.getTime() >= recentCutoff)
    .map((d) => d.salaryInr);
  const prior = docs
    .filter(
      (d) =>
        d.submittedAt.getTime() < recentCutoff &&
        d.submittedAt.getTime() >= priorCutoff,
    )
    .map((d) => d.salaryInr);
  let yoyChangePercent: number | null = null;
  if (recent.length >= MIN_DATA_POINTS && prior.length >= MIN_DATA_POINTS) {
    const avgRecent = recent.reduce((s, n) => s + n, 0) / recent.length;
    const avgPrior = prior.reduce((s, n) => s + n, 0) / prior.length;
    yoyChangePercent = Math.round(((avgRecent - avgPrior) / avgPrior) * 100);
  }

  const payload = {
    role,
    city,
    dataPointsCount: docs.length,
    percentiles: { p10, p25, p50, p75, p90 },
    byExperience,
    topCompanies,
    yoyChangePercent,
    lastUpdated: new Date(),
  };

  await redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify(payload));
  res.json({ success: true, data: payload });
});

export const submitSalary = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const body = req.body as z.infer<typeof submitSchema>['body'];

  // Upsert per (user, role, city) — keeps the per-user cap honest.
  await SalarySubmission.findOneAndUpdate(
    {
      user: req.user._id,
      role: body.role.toLowerCase(),
      city: body.city.toLowerCase(),
    },
    {
      $set: {
        user: req.user._id,
        role: body.role.toLowerCase(),
        city: body.city.toLowerCase(),
        industry: body.industry?.toLowerCase(),
        company: body.company,
        experienceYears: body.experienceYears,
        salaryInr: body.salaryInr,
        submittedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );

  // Bust the cache for this slice so the next read reflects the change.
  await redis.del(cacheKey(body.role, body.city));

  res.status(201).json({ success: true, message: 'Submitted — thank you!' });
});

export const compareSalary = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { role, city, salaryInr } = req.body as z.infer<
    typeof compareSchema
  >['body'];

  const docs = await SalarySubmission.find({
    role: role.toLowerCase(),
    city: city.toLowerCase(),
  })
    .select('salaryInr')
    .lean();

  if (docs.length < MIN_DATA_POINTS) {
    res.json({
      success: true,
      data: {
        notEnoughData: true,
        minDataPoints: MIN_DATA_POINTS,
        dataPointsCount: docs.length,
      },
    });
    return;
  }

  const salaries = docs.map((d) => d.salaryInr).sort((a, b) => a - b);
  // Percentile = % of submissions strictly less than the given salary.
  const lessThan = salaries.filter((s) => s < salaryInr).length;
  const percentileRank = Math.round((lessThan / salaries.length) * 100);

  const median = percentile(salaries, 50);

  res.json({
    success: true,
    data: {
      percentile: percentileRank,
      median,
      yourSalary: salaryInr,
      dataPointsCount: salaries.length,
    },
  });
});
