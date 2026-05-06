import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Job } from '../models/Job';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { redis, CACHE_KEYS } from '../config/redis';
import { env } from '../config/env';
import { matchJobsForUser } from '../services/ai/matcher.service';
import { runJobFetchNow } from '../jobs/jobScraper.cron';
import { buildAllJobsPayload, warmJobsCache, clearJobsCache } from '../services/jobCache.service';
import { logger } from '../utils/logger';

export const listJobsSchema = z.object({
  query: z.object({
    q: z.string().optional(),
    location: z.string().optional(),
    company: z.string().optional(),
    jobType: z.string().optional(),
    remoteType: z.string().optional(),
    skills: z.string().optional(),
    minSalary: z.coerce.number().optional(),
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    sort: z.enum(['recent', 'salary', 'relevance']).default('recent'),
  }),
});

const buildFilter = (q: Record<string, unknown>): Record<string, unknown> => {
  const cutoff = new Date(Date.now() - env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
  const filter: Record<string, unknown> = {
    isActive: true,
    postedAt: { $gte: cutoff },
  };
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

  const qStr = str(q.q);
  if (qStr) filter.$text = { $search: qStr };
  const loc = str(q.location);
  if (loc) filter.location = { $regex: loc, $options: 'i' };
  const company = str(q.company);
  if (company) filter.company = { $regex: company, $options: 'i' };
  if (str(q.jobType)) filter.jobType = q.jobType;
  if (str(q.remoteType)) filter.remoteType = q.remoteType;
  const skills = str(q.skills);
  if (skills) {
    const arr = skills.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (arr.length) filter.skills = { $in: arr };
  }
  if (q.minSalary) filter.salaryMin = { $gte: Number(q.minSalary) };
  return filter;
};

const SEARCH_PARAMS = ['q', 'location', 'company', 'jobType', 'remoteType', 'skills', 'minSalary'];

const isSearchMode = (q: Record<string, unknown>): boolean =>
  SEARCH_PARAMS.some((k) => typeof q[k] === 'string' && (q[k] as string).length > 0);

export const listJobs = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) throw ApiError.unauthorized();

  const q = req.query as Record<string, unknown>;
  const numQ = (v: unknown, dflt: number): number => {
    const n = typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : dflt;
  };
  const page = numQ(q.page, 1);
  const limit = numQ(q.limit, 20);
  const skip = (page - 1) * limit;

  if (!isSearchMode(q)) {
    matchedJobs(req, res, next);
    return;
  }

  const cacheKey = `jobs:search:${req.user.id}:${JSON.stringify(q)}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    res.json(JSON.parse(cached));
    return;
  }

  const filter = buildFilter(q);

  const sort: Record<string, 1 | -1> = { postedAt: -1 };
  if (q.sort === 'salary') {
    sort.salaryMax = -1;
    sort.salaryMin = -1;
  }

  const [items, total] = await Promise.all([
    Job.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Job.countDocuments(filter),
  ]);

  const payload = {
    success: true,
    mode: 'search',
    data: items,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };

  await redis.setex(cacheKey, env.REDIS_JOB_CACHE_TTL, JSON.stringify(payload));
  res.json(payload);
});

export const listAllJobs = asyncHandler(async (_req: AuthRequest, res: Response) => {
  const cached = await redis.get(CACHE_KEYS.ALL_JOBS);
  if (cached) {
    res.json(JSON.parse(cached));
    return;
  }

  const payload = await buildAllJobsPayload();
  await redis.setex(CACHE_KEYS.ALL_JOBS, env.REDIS_JOB_CACHE_TTL, JSON.stringify(payload));
  res.json(payload);
});

export const warmCache = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== 'admin') throw ApiError.forbidden('Admin only');
  const result = await warmJobsCache();
  res.json({ success: true, message: 'Cache warmed', data: result });
});

export const clearCache = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== 'admin') throw ApiError.forbidden('Admin only');
  const result = await clearJobsCache();
  res.json({ success: true, message: 'Cache cleared', data: result });
});

export const getJob = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const cached = await redis.get(CACHE_KEYS.JOB_BY_ID(id));
  if (cached) {
    res.json({ success: true, data: JSON.parse(cached) });
    return;
  }

  const job = await Job.findById(id).lean();
  if (!job) throw ApiError.notFound('Job not found');

  await redis.setex(CACHE_KEYS.JOB_BY_ID(id), env.REDIS_JOB_CACHE_TTL, JSON.stringify(job));
  res.json({ success: true, data: job });
});

export const matchedJobs = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const useAi = req.query.ai === 'true';
  const thresholdRaw = typeof req.query.threshold === 'string' ? Number(req.query.threshold) : NaN;
  const threshold = Number.isFinite(thresholdRaw)
    ? Math.min(100, Math.max(0, thresholdRaw))
    : env.AI_MATCH_THRESHOLD;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const limit = Math.min(500, Number.isFinite(limitRaw) ? limitRaw : 100);

  const cacheKey = `${CACHE_KEYS.USER_MATCHED_JOBS(req.user.id)}:${useAi}:${threshold}:${limit}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    res.json(JSON.parse(cached));
    return;
  }

  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound('User not found');

  const cutoff = new Date(Date.now() - env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
  const profileComplete = Boolean(
    user.profile.skills?.length || user.profile.preferredRoles?.length,
  );

  if (!profileComplete) {
    const recent = await Job.find({ isActive: true, postedAt: { $gte: cutoff } })
      .sort({ postedAt: -1 })
      .limit(limit)
      .lean();

    const fallbackPayload = {
      success: true,
      data: recent.map((j) => ({
        job: j,
        score: null,
        matchedSkills: [],
        missingSkills: [],
        reasoning: null,
      })),
      meta: {
        total: recent.length,
        threshold,
        useAi,
        profileIncomplete: true,
        nextStep: 'Add skills and preferred roles to your profile to get personalized 80%+ matches',
      },
    };
    await redis.setex(cacheKey, 600, JSON.stringify(fallbackPayload));
    res.json(fallbackPayload);
    return;
  }

  const candidateFilter: Record<string, unknown> = {
    isActive: true,
    postedAt: { $gte: cutoff },
    $or: [
      ...(user.profile.skills?.length
        ? [{ skills: { $in: user.profile.skills.map((s) => s.toLowerCase()) } }]
        : []),
      ...(user.profile.preferredRoles?.length
        ? [{ title: { $regex: user.profile.preferredRoles.join('|'), $options: 'i' } }]
        : []),
    ],
  };

  const candidates = await Job.find(candidateFilter).sort({ postedAt: -1 }).limit(1000);

  const matched = await matchJobsForUser(user, candidates, threshold, useAi);
  const top = matched.slice(0, limit);

  const payload = {
    success: true,
    data: top.map((m) => ({
      job: m.job,
      score: m.match.score,
      matchedSkills: m.match.matchedSkills,
      missingSkills: m.match.missingSkills,
      reasoning: m.match.reasoning,
    })),
    meta: {
      total: matched.length,
      threshold,
      useAi,
      profileIncomplete: false,
      candidatePoolSize: candidates.length,
    },
  };

  await redis.setex(cacheKey, 1800, JSON.stringify(payload));
  res.json(payload);
});

export const triggerFetch = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user || req.user.role !== 'admin') throw ApiError.forbidden('Admin only');
  try {
    const result = await runJobFetchNow();
    res.json({ success: true, message: 'Job fetch triggered', data: result });
  } catch (err) {
    logger.error('Manual fetch failed', err);
    throw ApiError.internal('Failed to trigger fetch');
  }
});
