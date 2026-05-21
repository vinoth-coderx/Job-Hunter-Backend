import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Job } from '../models/Job';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest, JobSource } from '../types';
import { matchJobsForUser } from '../services/ai/matcher.service';
import { aiJobSearch } from '../services/ai/jobSearch.service';
import { buildAllJobsPayload } from '../services/jobCache.service';
import {
  FeedJob,
  hydrateTrust,
  toFeedJobFromNative,
  toFeedJobFromScraped,
  deriveProfileQueries,
  deriveProfileLocations,
  fetchExternalForProfile,
  buildAppliedExclusion,
  filterApplied,
  lookupExternalJobFromCache,
} from '../services/jobFeed.service';
import { logger } from '../utils/logger';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
// Allow underscores so multi-word source slugs (e.g. `realtime_web_search`)
// don't fall through to the "Invalid job id" branch.
const EXTERNAL_ID_RE = /^([a-z][a-z0-9_]*):(.+)$/i;

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

const SEARCH_PARAMS = [
  'q',
  'location',
  'company',
  'jobType',
  'remoteType',
  'skills',
  'minSalary',
];

const isSearchMode = (q: Record<string, unknown>): boolean =>
  SEARCH_PARAMS.some(
    (k) => typeof q[k] === 'string' && (q[k] as string).length > 0,
  );

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const numQ = (v: unknown, dflt: number): number => {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
};

/**
 * Native-only Mongo filter. Third-party jobs no longer live in the DB,
 * so we look strictly at hirer-posted listings here. Freshness is driven
 * by `status: 'active'` (hirers control the lifecycle), not by postedAt.
 */
const buildNativeFilter = (q: Record<string, unknown>): Record<string, unknown> => {
  const filter: Record<string, unknown> = {
    isNative: true,
    isActive: true,
    status: 'active',
    // Only surface native listings that have cleared moderation. External
    // (scraped) jobs aren't gated on this flag — they go through the
    // source-level trust check inside the scrapers instead.
    isPublic: true,
  };

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
    const arr = skills
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (arr.length) filter.skills = { $in: arr };
  }
  if (q.minSalary) filter.salaryMin = { $gte: Number(q.minSalary) };
  return filter;
};

/**
 * In-memory filter applied to live external jobs so the same q/location/
 * etc. params behave consistently across both sources. Scraper queries
 * are coarse (free-text into the provider), so we still re-check here.
 */
const applyExternalFilters = (
  jobs: FeedJob[],
  q: Record<string, unknown>,
): FeedJob[] => {
  const qStr = str(q.q)?.toLowerCase();
  const loc = str(q.location)?.toLowerCase();
  const company = str(q.company)?.toLowerCase();
  const jobType = str(q.jobType);
  const remoteType = str(q.remoteType);
  const skillsCsv = str(q.skills);
  const minSalary = q.minSalary ? Number(q.minSalary) : undefined;
  const requiredSkills = skillsCsv
    ? skillsCsv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];

  return jobs.filter((j) => {
    if (qStr) {
      const hay = `${j.title} ${j.description} ${j.company}`.toLowerCase();
      if (!hay.includes(qStr)) return false;
    }
    if (loc && !j.location.toLowerCase().includes(loc)) return false;
    if (company && !j.company.toLowerCase().includes(company)) return false;
    if (jobType && j.jobType !== jobType) return false;
    if (remoteType && j.remoteType !== remoteType) return false;
    if (requiredSkills.length) {
      const have = (j.skills || []).map((s) => s.toLowerCase());
      if (!requiredSkills.some((s) => have.includes(s))) return false;
    }
    if (minSalary !== undefined) {
      if (typeof j.salaryMin === 'number') {
        if (j.salaryMin < minSalary) return false;
      } else if (typeof j.salaryMax === 'number') {
        if (j.salaryMax < minSalary) return false;
      } else {
        // No salary info — keep (search shouldn't punish missing data)
      }
    }
    return true;
  });
};

// Relevance score (0-100) for ranking search/filter results. Used to
// re-sort results that already pass the exact-match filters
// (jobType/remoteType/company/skills/etc.) so the strongest free-text
// + skill overlap rises to the top. Not used as a hard gate — the
// filters themselves already enforce "what the user picked".
const filterRelevance = (
  job: FeedJob,
  q: Record<string, unknown>,
): number => {
  let total = 0;
  let hit = 0;

  const qStr = str(q.q)?.toLowerCase();
  if (qStr) {
    total += 1;
    const titleLc = job.title.toLowerCase();
    const skillBag = (job.skills || []).join(' ').toLowerCase();
    if (titleLc.includes(qStr) || skillBag.includes(qStr)) {
      hit += 1;
    } else if (job.description.toLowerCase().includes(qStr)) {
      // Description-only match is a weaker signal — half weight so a
      // job that only mentions the keyword in passing won't clear 90%.
      hit += 0.5;
    }
  }

  const loc = str(q.location)?.toLowerCase();
  if (loc) {
    total += 1;
    if (job.location.toLowerCase().includes(loc)) hit += 1;
  }

  const skillsCsv = str(q.skills);
  if (skillsCsv) {
    const req = skillsCsv
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (req.length > 0) {
      const have = (job.skills || []).map((s) => s.toLowerCase());
      const titleLc = job.title.toLowerCase();
      const descLc = job.description.toLowerCase();
      const matchedCount = req.filter(
        (s) =>
          have.some((h) => h.includes(s)) ||
          titleLc.includes(s) ||
          descLc.includes(s),
      ).length;
      total += req.length;
      hit += matchedCount;
    }
  }

  // jobType / remoteType / company / minSalary are exact-match filters
  // already gated by buildNativeFilter / applyExternalFilters; double-
  // counting them in relevance would distort the score.

  if (total === 0) return 100;
  return Math.round((hit / total) * 100);
};

// Words that show up in queries but carry no search signal. Stripped
// before the must-match check so "developer in india" doesn't require
// "in" to appear in the job text.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or',
  'the', 'to', 'with', 'job', 'jobs', 'role', 'roles', 'work',
]);

/// Strict "did the user's typed query actually appear in this job?"
/// check. Tokenises q, drops stopwords + sub-3-char tokens, requires
/// every remaining token to appear across title/skills/responsibilities/
/// department/description. Without this, Mongo's `$text` query (which
/// is OR by default) lets a "react native" search return Shopify-tech
/// jobs that only mention "react" and marketing roles that only
/// mention "native ads".
const matchesRawQ = (job: FeedJob, rawQ: string | undefined): boolean => {
  if (!rawQ) return true;
  const tokens = rawQ
    .toLowerCase()
    .split(/[\s,/+&|()\-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (tokens.length === 0) return true;

  const haystack = [
    job.title,
    (job.skills || []).join(' '),
    (job.responsibilities || []).join(' '),
    job.department || '',
    job.description,
  ]
    .join(' ')
    .toLowerCase();

  return tokens.every((t) => haystack.includes(t));
};

const sortFeedJobs = (
  jobs: FeedJob[],
  sort: string | undefined,
): FeedJob[] => {
  if (sort === 'salary') {
    return [...jobs].sort((a, b) => {
      const aSal = a.salaryMax ?? a.salaryMin ?? 0;
      const bSal = b.salaryMax ?? b.salaryMin ?? 0;
      return bSal - aSal;
    });
  }
  return [...jobs].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
};

export const listJobs = asyncHandler(
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const q = req.query as Record<string, unknown>;
    const page = numQ(q.page, 1);
    const limit = numQ(q.limit, 20);
    const skip = (page - 1) * limit;

    // Logged-in users browsing without filters get personalised matches.
    if (!isSearchMode(q) && req.user) {
      matchedJobs(req, res, next);
      return;
    }

    const user = req.user ? await User.findById(req.user._id) : null;

    // Native results — query the DB with the user's filters.
    const nativeFilter = buildNativeFilter(q);
    const native = await Job.find(nativeFilter).limit(500).lean();
    const nativeFeed = await hydrateTrust(
      native.map((n) =>
        toFeedJobFromNative(n as unknown as Parameters<typeof toFeedJobFromNative>[0]),
      ),
    );

    // External results — live fetch using either the search query or the
    // user's profile-derived queries (so an authenticated user with a blank
    // location still gets locale-relevant results).
    const queries = deriveProfileQueries(user, str(q.q));
    const locations = deriveProfileLocations(user, str(q.location));
    const externalScraped = queries.length
      ? await fetchExternalForProfile(queries, locations)
      : [];
    const externalFeed = applyExternalFilters(
      externalScraped.map(toFeedJobFromScraped),
      q,
    );

    // Merge, exclude applied, enforce phrase-level q match, sort,
    // paginate. matchesRawQ rejects results where Mongo's `$text`
    // matched only one token of a multi-word query (the "react native"
    // → Shopify-tech-lead bleed). filterRelevance is kept for ranking
    // — it lets stronger free-text + skill overlap rise to the top
    // without dropping legitimate hits.
    const rawQ = str(q.q);
    const merged = [...nativeFeed, ...externalFeed];
    const applied = await buildAppliedExclusion(req.user?._id?.toString());
    const dedupedByApply = filterApplied(merged, applied);
    const phraseMatched = dedupedByApply.filter((j) => matchesRawQ(j, rawQ));
    const ranked = phraseMatched
      .map((j) => ({ job: j, score: filterRelevance(j, q) }))
      .sort((a, b) => b.score - a.score)
      .map((r) => r.job);
    const sorted = sortFeedJobs(ranked, str(q.sort));

    const total = sorted.length;
    const items = sorted.slice(skip, skip + limit);

    res.json({
      success: true,
      mode: 'search',
      data: items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        nativeCount: nativeFeed.length,
        externalCount: externalFeed.length,
        candidatePoolSize: dedupedByApply.length,
        ...(total === 0
          ? {
              noMatches: true,
              nextStep:
                'No results match all your filters. Try broadening the search or removing one filter.',
            }
          : {}),
      },
    });
  },
);

export const listAllJobs = asyncHandler(async (_req: AuthRequest, res: Response) => {
  const payload = await buildAllJobsPayload();
  res.json(payload);
});

export const getJob = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);

  if (OBJECT_ID_RE.test(id)) {
    const job = await Job.findById(id)
      .populate('hirerProfile', 'verification trustScore approvalStatus')
      .lean();
    if (!job) throw ApiError.notFound('Job not found');
    const hp = job.hirerProfile as unknown as
      | {
          verification?: { isVerified?: boolean };
          trustScore?: number;
          approvalStatus?: string;
        }
      | undefined;
    res.json({
      success: true,
      data: {
        ...toFeedJobFromNative(
          job as unknown as Parameters<typeof toFeedJobFromNative>[0],
        ),
        // Seeker-side trust signals. The feed-job shape doesn't carry
        // these by default (saves a populate on every list query); we
        // graft them on for the detail screen because they drive the
        // VerifiedBadge / SafeApplyBadge / FraudWarningBanner rendering.
        companyVerified: hp?.verification?.isVerified === true,
        recruiterTrustScore: hp?.trustScore ?? null,
        recruiterApproved: (hp?.approvalStatus ?? 'approved') === 'approved',
      },
    });
    return;
  }

  const m = EXTERNAL_ID_RE.exec(id);
  if (m) {
    const source = m[1] as JobSource;
    const externalId = m[2];
    const cached = await lookupExternalJobFromCache(source, externalId);
    if (!cached) {
      throw ApiError.notFound(
        'External job not in cache. Re-open from search results.',
      );
    }
    res.json({ success: true, data: toFeedJobFromScraped(cached) });
    return;
  }

  throw ApiError.badRequest('Invalid job id');
});

// "Shows weak signal of profile overlap" floor. Lower than the original
// 70% strict gate — we learned that strict thresholds produce empty
// feeds for sparse profiles. The ranking still puts the strongest
// matches on top; this floor only excludes outright-irrelevant jobs.
const DEFAULT_MATCH_FLOOR = 30;

export const matchedJobs = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const useAi = req.query.ai === 'true';
  const thresholdRaw =
    typeof req.query.threshold === 'string' ? Number(req.query.threshold) : NaN;
  const threshold = Number.isFinite(thresholdRaw)
    ? Math.min(100, Math.max(0, thresholdRaw))
    : DEFAULT_MATCH_FLOOR;
  const page = Math.max(1, numQ(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, numQ(req.query.limit, 20)));
  const skip = (page - 1) * limit;

  // Guests see a public, recency-sorted slice of native jobs only. No
  // profile to derive third-party queries from, so the live API call is
  // skipped — search-mode is what guests should hit if they want the
  // broader scrape pool.
  if (req.user.role === 'guest') {
    const baseFilter = { isNative: true, isActive: true, status: 'active' };
    const [items, total] = await Promise.all([
      Job.find(baseFilter).sort({ postedAt: -1 }).skip(skip).limit(limit).lean(),
      Job.countDocuments(baseFilter),
    ]);
    const feedItems = await hydrateTrust(
      items.map((j) =>
        toFeedJobFromNative(
          j as unknown as Parameters<typeof toFeedJobFromNative>[0],
        ),
      ),
    );
    res.json({
      success: true,
      data: feedItems.map((job) => ({
        job,
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

  // No profile signal yet → show native jobs by recency so the feed isn't
  // empty. The blocking banner from the frontend will nudge the user to
  // fill the profile so the third-party fetch starts firing.
  if (!profileComplete) {
    const baseFilter = { isNative: true, isActive: true, status: 'active' };
    const [items, total] = await Promise.all([
      Job.find(baseFilter).sort({ postedAt: -1 }).skip(skip).limit(limit).lean(),
      Job.countDocuments(baseFilter),
    ]);
    const feedItems = await hydrateTrust(
      items.map((j) =>
        toFeedJobFromNative(
          j as unknown as Parameters<typeof toFeedJobFromNative>[0],
        ),
      ),
    );
    res.json({
      success: true,
      data: feedItems.map((job) => ({
        job,
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
        nextStep:
          'Add skills and preferred roles to your profile to get personalised matches.',
      },
    });
    return;
  }

  // Native candidates: hirer-posted jobs that overlap the user's skills or
  // preferred roles. We keep the candidate filter so the matcher doesn't
  // score the entire native pool — skill/role overlap is a coarse pre-filter.
  const candidateFilter: Record<string, unknown> = {
    isNative: true,
    isActive: true,
    status: 'active',
    $or: [
      ...(user.profile.skills?.length
        ? [{ skills: { $in: user.profile.skills.map((s) => s.toLowerCase()) } }]
        : []),
      ...(user.profile.preferredRoles?.length
        ? [
            {
              title: {
                $regex: user.profile.preferredRoles.join('|'),
                $options: 'i',
              },
            },
          ]
        : []),
    ],
  };
  const nativeDocs = await Job.find(candidateFilter)
    .sort({ postedAt: -1 })
    .limit(500)
    .lean();
  const nativeFeed = await hydrateTrust(
    nativeDocs.map((n) =>
      toFeedJobFromNative(n as unknown as Parameters<typeof toFeedJobFromNative>[0]),
    ),
  );

  // External candidates: profile-driven live fetch (cached in Redis).
  const queries = deriveProfileQueries(user);
  const locations = deriveProfileLocations(user);
  const externalScraped = await fetchExternalForProfile(queries, locations);
  const externalFeed = externalScraped.map(toFeedJobFromScraped);

  const applied = await buildAppliedExclusion(req.user._id?.toString());
  const merged = filterApplied([...nativeFeed, ...externalFeed], applied);

  const matched = await matchJobsForUser(user, merged, threshold, useAi);

  // No "show everything" fallback here on purpose. The screen requires
  // jobs to match the seeker's profile (skills + roles) at >= threshold;
  // otherwise it returns empty + a flag so the client can render an
  // honest empty state ("No matches yet — add more skills / broaden
  // location") instead of dumping unrelated postings into the feed.
  if (matched.length === 0) {
    res.json({
      success: true,
      data: [],
      meta: {
        page,
        limit,
        total: 0,
        totalPages: 0,
        hasMore: false,
        threshold,
        useAi,
        profileIncomplete: false,
        noMatches: true,
        candidatePoolSize: merged.length,
        nextStep:
          'No jobs cleared the match threshold. Add more skills / preferred roles to your profile, or broaden your preferred locations.',
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
      // Emit null when the score is 0 (empty profile, no signal) so the
      // client can omit the match badge instead of rendering "0%".
      score: m.match.score > 0 ? m.match.score : null,
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
      candidatePoolSize: merged.length,
      nativeCount: nativeFeed.length,
      externalCount: externalFeed.length,
    },
  });
});

export const aiSearchSchema = z.object({
  body: z.object({
    query: z.string().min(1).max(500),
    limit: z.coerce.number().min(1).max(50).optional(),
    excludeAppliedJobs: z.boolean().optional().default(true),
  }),
});

/// AI-powered semantic job search. Accepts a natural-language query
/// ("senior react dev in bangalore, 15 LPA"), extracts intent via the AI
/// provider, and matches across title, skills, description, etc.
/// Already-applied jobs are filtered out by default so they don't pollute
/// the discovery surface.
export const aiSearchJobs = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const { query, limit, excludeAppliedJobs } = req.body as z.infer<
      typeof aiSearchSchema
    >['body'];

    const applied = excludeAppliedJobs
      ? await buildAppliedExclusion(req.user?._id?.toString())
      : undefined;

    const result = await aiJobSearch({
      query,
      limit: limit ?? 30,
      excludeApplied: applied,
    });

    res.json({
      success: true,
      data: result.jobs,
      meta: {
        intent: result.intent,
        total: result.total,
        scope: result.scope,
        nativeCount: result.nativeCount,
        externalCount: result.externalCount,
      },
    });
  },
);
