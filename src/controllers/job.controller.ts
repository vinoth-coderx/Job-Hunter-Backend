import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Job } from '../models/Job';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { env } from '../config/env';
import { matchJobsForUser } from '../services/ai/matcher.service';
import { runJobFetchNow } from '../jobs/jobScraper.cron';
import { buildAllJobsPayload } from '../services/jobCache.service';
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
  const q = req.query as Record<string, unknown>;
  const numQ = (v: unknown, dflt: number): number => {
    const n = typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : dflt;
  };
  const page = numQ(q.page, 1);
  const limit = numQ(q.limit, 20);
  const skip = (page - 1) * limit;

  // Logged-in users browsing without filters get personalised matches.
  // Guests fall through to the recency-sorted public listing below.
  if (!isSearchMode(q) && req.user) {
    matchedJobs(req, res, next);
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

  res.json({
    success: true,
    mode: 'search',
    data: items,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

export const listAllJobs = asyncHandler(async (_req: AuthRequest, res: Response) => {
  const payload = await buildAllJobsPayload();
  res.json(payload);
});

export const getJob = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const job = await Job.findById(id).lean();
  if (!job) throw ApiError.notFound('Job not found');
  res.json({ success: true, data: job });
});

// Default match floor for the home feed: only show jobs the matcher
// rates >= 50%. Clients can override with ?threshold= up to 100.
const DEFAULT_MATCH_FLOOR = 50;

export const matchedJobs = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const useAi = req.query.ai === 'true';
  const thresholdRaw = typeof req.query.threshold === 'string' ? Number(req.query.threshold) : NaN;
  const threshold = Number.isFinite(thresholdRaw)
    ? Math.min(100, Math.max(0, thresholdRaw))
    : DEFAULT_MATCH_FLOOR;
  const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
  const page = Math.max(1, Number.isFinite(pageRaw) ? Math.floor(pageRaw) : 1);
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20));
  const skip = (page - 1) * limit;
  const cutoff = new Date(Date.now() - env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);

  // Guests have no profile to match against, so we serve a recency-sorted
  // public listing wrapped in the same shape as the matched response. No
  // skill / category filter — the result spans every domain in the DB
  // (IT, non-IT, core, finance, sales, …) so guests see the full breadth.
  if (req.user.role === 'guest') {
    const baseFilter = { isActive: true, postedAt: { $gte: cutoff } };
    const [items, total] = await Promise.all([
      Job.find(baseFilter).sort({ postedAt: -1 }).skip(skip).limit(limit).lean(),
      Job.countDocuments(baseFilter),
    ]);
    res.json({
      success: true,
      data: items.map((j) => ({
        job: j,
        score: null,
        matchedSkills: [],
        missingSkills: [],
        reasoning: null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + items.length < total,
        threshold,
        useAi: false,
        guest: true,
        nextStep: 'Sign in with Google to get personalised matches.',
      },
    });
    return;
  }

  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound('User not found');

  const profileComplete = Boolean(
    user.profile.skills?.length || user.profile.preferredRoles?.length,
  );

  if (!profileComplete) {
    const baseFilter = { isActive: true, postedAt: { $gte: cutoff } };
    const [items, total] = await Promise.all([
      Job.find(baseFilter).sort({ postedAt: -1 }).skip(skip).limit(limit).lean(),
      Job.countDocuments(baseFilter),
    ]);
    res.json({
      success: true,
      data: items.map((j) => ({
        job: j,
        score: null,
        matchedSkills: [],
        missingSkills: [],
        reasoning: null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + items.length < total,
        threshold,
        useAi,
        profileIncomplete: true,
        nextStep: 'Add skills and preferred roles to your profile to get personalised matches.',
      },
    });
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

  // Pull a wide candidate pool, score every one, then paginate over the
  // sorted-desc result. The matcher already drops anything below
  // `threshold`, so once we slice we have only >=50% scoring jobs ordered
  // highest-first. Pool size of 1000 keeps the per-request work bounded.
  const candidates = await Job.find(candidateFilter).sort({ postedAt: -1 }).limit(1000);
  const matched = await matchJobsForUser(user, candidates, threshold, useAi);

  // Recency fallback: a profile-complete user whose skills/roles don't
  // overlap with any job in the freshness window would otherwise see an
  // empty home. Serve the unfiltered recent feed (same shape, score=null)
  // so the home is never blank — UI ranking still prefers scored matches
  // when they exist on a later refresh.
  if (matched.length === 0) {
    const baseFilter = { isActive: true, postedAt: { $gte: cutoff } };
    const [items, total] = await Promise.all([
      Job.find(baseFilter).sort({ postedAt: -1 }).skip(skip).limit(limit).lean(),
      Job.countDocuments(baseFilter),
    ]);
    res.json({
      success: true,
      data: items.map((j) => ({
        job: j,
        score: null,
        matchedSkills: [],
        missingSkills: [],
        reasoning: null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + items.length < total,
        threshold,
        useAi,
        profileIncomplete: false,
        noMatchesFallback: true,
        candidatePoolSize: candidates.length,
      },
    });
    return;
  }

  const total = matched.length;
  const slice = matched.slice(skip, skip + limit);

  res.json({
    success: true,
    data: slice.map((m) => ({
      job: m.job,
      score: m.match.score,
      matchedSkills: m.match.matchedSkills,
      missingSkills: m.match.missingSkills,
      reasoning: m.match.reasoning,
    })),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + slice.length < total,
      threshold,
      useAi,
      profileIncomplete: false,
      candidatePoolSize: candidates.length,
    },
  });
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
