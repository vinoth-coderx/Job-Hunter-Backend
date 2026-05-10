import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { env } from '../../config/env';
import { JOB_FRESHNESS_DAYS } from '../../config/constants';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { Job, IJob } from '../../models/Job';

const client = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

const MODEL = 'claude-haiku-4-5-20251001';

// Intent extracted from a free-form search query. Every field is optional —
// the user can be vague ("frontend jobs") or precise ("senior react roles
// in bangalore, 15 LPA min, remote"). The MongoDB query below combines
// whatever fields came back into a single multi-field match.
export interface SearchIntent {
  titleKeywords: string[];
  skills: string[];
  roleKeywords: string[];
  companyKeywords: string[];
  location?: string;
  jobType?: 'full-time' | 'part-time' | 'contract' | 'internship' | 'temporary';
  remoteType?: 'remote' | 'hybrid' | 'onsite';
  experienceMinYears?: number;
  experienceMaxYears?: number;
  salaryMinLpa?: number;
  freeText?: string;
}

/// Normalise the query for cache lookup so trivial differences
/// ("react dev"  vs " React  Dev! ") share the same intent
/// extraction. Lowercase, strip non-alphanumerics (preserving spaces),
/// then collapse runs of whitespace.
const normaliseQueryForCache = (q: string): string =>
  q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const cacheKeyForIntent = (q: string) =>
  `jobsearch:intent:${crypto
    .createHash('sha1')
    .update(normaliseQueryForCache(q))
    .digest('hex')}`;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cleanList = (xs: unknown): string[] =>
  Array.isArray(xs)
    ? xs
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter((x) => x.length >= 2 && x.length <= 60)
        .slice(0, 8)
    : [];

const cleanString = (s: unknown, max = 80): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t.length >= 2 && t.length <= max ? t : undefined;
};

const cleanNumber = (n: unknown): number | undefined => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return n;
};

const cleanEnum = <T extends string>(s: unknown, allowed: readonly T[]): T | undefined => {
  if (typeof s !== 'string') return undefined;
  const v = s.trim().toLowerCase() as T;
  return allowed.includes(v) ? v : undefined;
};

const REMOTE = ['remote', 'hybrid', 'onsite'] as const;
const JOB_TYPE = [
  'full-time',
  'part-time',
  'contract',
  'internship',
  'temporary',
] as const;

/// Heuristic intent extractor used when the LLM is unavailable. Splits
/// the query into tokens and treats every long-enough token as a generic
/// search term — falls back to plain `$text` search downstream.
const heuristicIntent = (query: string): SearchIntent => {
  const lc = query.toLowerCase();
  const tokens = lc
    .split(/[\s,/+&|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const remote = REMOTE.find((r) => lc.includes(r));
  const jobType =
    lc.includes('full time') || lc.includes('full-time') ? 'full-time'
    : lc.includes('part time') || lc.includes('part-time') ? 'part-time'
    : lc.includes('intern') ? 'internship'
    : lc.includes('contract') || lc.includes('freelance') ? 'contract'
    : undefined;

  return {
    titleKeywords: tokens.slice(0, 5),
    skills: [],
    roleKeywords: tokens.slice(0, 5),
    companyKeywords: [],
    remoteType: remote,
    jobType,
    freeText: query,
  };
};

/// Calls Claude Haiku to parse a natural-language search into structured
/// filters. Cached for 24h per query so repeated typed searches don't
/// re-hit the LLM. Falls back to a heuristic when the LLM key is unset.
export const extractSearchIntent = async (query: string): Promise<SearchIntent> => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      titleKeywords: [],
      skills: [],
      roleKeywords: [],
      companyKeywords: [],
    };
  }

  const cached = await redis.get(cacheKeyForIntent(trimmed));
  if (cached) {
    try {
      return JSON.parse(cached) as SearchIntent;
    } catch {
      // fall through to fresh extraction
    }
  }

  if (!client) {
    const intent = heuristicIntent(trimmed);
    await redis.setex(cacheKeyForIntent(trimmed), 86400, JSON.stringify(intent));
    return intent;
  }

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: [
        {
          type: 'text',
          text: 'You parse a job seeker\'s natural-language query into structured filters. Identify role/title keywords, skills, target companies, location, job type, remote preference, experience range, and salary expectation. Return strict JSON only — no prose, no markdown.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Parse this job search query into structured filters.

Query: "${trimmed}"

Return JSON with this exact shape (omit fields that aren't in the query):
{
  "titleKeywords": ["e.g. senior, flutter, developer"],
  "skills": ["e.g. flutter, dart, firebase"],
  "roleKeywords": ["e.g. frontend developer, backend engineer"],
  "companyKeywords": ["e.g. google, faang"],
  "location": "city or region (string)",
  "jobType": "full-time | part-time | contract | internship | temporary",
  "remoteType": "remote | hybrid | onsite",
  "experienceMinYears": <number>,
  "experienceMaxYears": <number>,
  "salaryMinLpa": <number, in INR lakhs per annum>,
  "freeText": "the original query verbatim"
}

Examples:
- "senior react dev in bangalore" → titleKeywords=["senior","react","developer"], skills=["react"], roleKeywords=["frontend developer"], location="bangalore"
- "remote flutter jobs 15 LPA" → skills=["flutter"], remoteType="remote", salaryMinLpa=15
- "full time data scientist with python at faang" → titleKeywords=["data","scientist"], skills=["python"], jobType="full-time", companyKeywords=["google","meta","amazon","apple","netflix"]`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    // Strip code fences if the model wrapped the JSON
    const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const intent: SearchIntent = {
      titleKeywords: cleanList(parsed.titleKeywords),
      skills: cleanList(parsed.skills),
      roleKeywords: cleanList(parsed.roleKeywords),
      companyKeywords: cleanList(parsed.companyKeywords),
      location: cleanString(parsed.location),
      jobType: cleanEnum(parsed.jobType, JOB_TYPE),
      remoteType: cleanEnum(parsed.remoteType, REMOTE),
      experienceMinYears: cleanNumber(parsed.experienceMinYears),
      experienceMaxYears: cleanNumber(parsed.experienceMaxYears),
      salaryMinLpa: cleanNumber(parsed.salaryMinLpa),
      freeText: trimmed,
    };

    await redis.setex(cacheKeyForIntent(trimmed), 86400, JSON.stringify(intent));
    return intent;
  } catch (err) {
    logger.warn(`jobSearch LLM intent failed: ${(err as Error).message}`);
    const intent = heuristicIntent(trimmed);
    await redis.setex(cacheKeyForIntent(trimmed), 86400, JSON.stringify(intent));
    return intent;
  }
};

// Search uses a more generous window than the feed — feed wants
// "fresh" matches, but a user typing a query expects results even when
// the cron hasn't run for a few days. Tunable so we can dial it
// independently of JOB_FRESHNESS_DAYS without re-deploying.
const SEARCH_FRESHNESS_DAYS = Math.max(JOB_FRESHNESS_DAYS, 60);

/// (location, jobType, remoteType, salary, experience) layer on top.
const buildMongoFilter = (
  intent: SearchIntent,
  excludeJobIds: string[],
  opts: { dropFreshness?: boolean; dropActive?: boolean } = {},
): Record<string, unknown> => {
  const cutoff = new Date(
    Date.now() - SEARCH_FRESHNESS_DAYS * 24 * 60 * 60 * 1000,
  );
  const filter: Record<string, unknown> = {};
  if (!opts.dropActive) filter.isActive = true;
  if (!opts.dropFreshness) filter.postedAt = { $gte: cutoff };

  if (excludeJobIds.length > 0) {
    filter._id = { $nin: excludeJobIds };
  }

  const orClauses: Record<string, unknown>[] = [];

  for (const kw of intent.titleKeywords) {
    const re = new RegExp(escapeRegex(kw), 'i');
    orClauses.push({ title: re });
    orClauses.push({ description: re });
  }
  for (const sk of intent.skills) {
    const re = new RegExp(escapeRegex(sk), 'i');
    orClauses.push({ skills: re });
    orClauses.push({ description: re });
    orClauses.push({ title: re });
  }
  for (const role of intent.roleKeywords) {
    const re = new RegExp(escapeRegex(role), 'i');
    orClauses.push({ title: re });
    orClauses.push({ department: re });
    orClauses.push({ responsibilities: re });
  }
  for (const co of intent.companyKeywords) {
    const re = new RegExp(escapeRegex(co), 'i');
    orClauses.push({ company: re });
  }

  if (orClauses.length > 0) {
    filter.$or = orClauses;
  } else if (intent.freeText && intent.freeText.length > 0) {
    // Fall back to MongoDB text index when nothing structured came out.
    filter.$text = { $search: intent.freeText };
  }

  if (intent.location) {
    filter.location = { $regex: escapeRegex(intent.location), $options: 'i' };
  }
  if (intent.jobType) filter.jobType = intent.jobType;
  if (intent.remoteType) filter.remoteType = intent.remoteType;

  if (typeof intent.salaryMinLpa === 'number') {
    // Salary fields are stored in absolute INR; convert LPA → rupees.
    filter.salaryMin = { $gte: intent.salaryMinLpa * 100000 };
  }

  if (typeof intent.experienceMinYears === 'number') {
    // Job's max-experience must be at least the user's expected min so
    // the candidate's experience could plausibly fit the band.
    filter.$and = [
      ...(filter.$and as Record<string, unknown>[] ?? []),
      {
        $or: [
          { experienceMaxYears: { $gte: intent.experienceMinYears } },
          { experienceMaxYears: { $exists: false } },
        ],
      },
    ];
  }

  return filter;
};

/// Lightweight relevance score over already-fetched jobs. Mirrors the
/// front-end token-weight scheme that used to live in JobProvider:
///   title 4× · skills 3× · responsibilities/department 2× · description 1×
/// Plus flat bonuses per matched company / location term.
const scoreJob = (job: IJob, intent: SearchIntent): number => {
  const title = job.title.toLowerCase();
  const desc = job.description.toLowerCase();
  const dept = (job.department || '').toLowerCase();
  const company = job.company.toLowerCase();
  const loc = job.location.toLowerCase();
  const skillBag = (job.skills || []).map((s) => s.toLowerCase());
  const respBag = (job.responsibilities || []).map((r) => r.toLowerCase());

  let s = 0;
  for (const t of intent.titleKeywords) {
    const lt = t.toLowerCase();
    if (title.includes(lt)) s += 4;
    if (desc.includes(lt)) s += 1;
  }
  for (const sk of intent.skills) {
    const lsk = sk.toLowerCase();
    if (skillBag.some((b) => b.includes(lsk))) s += 3;
    if (title.includes(lsk)) s += 2;
    if (desc.includes(lsk)) s += 1;
  }
  for (const role of intent.roleKeywords) {
    const lr = role.toLowerCase();
    if (title.includes(lr)) s += 3;
    if (dept.includes(lr)) s += 2;
    if (respBag.some((b) => b.includes(lr))) s += 2;
  }
  for (const co of intent.companyKeywords) {
    if (company.includes(co.toLowerCase())) s += 4;
  }
  if (intent.location && loc.includes(intent.location.toLowerCase())) s += 2;

  // Recency bias — under a week old gets up to +1, decays linearly.
  const ageDays =
    (Date.now() - new Date(job.postedAt).getTime()) / (1000 * 60 * 60 * 24);
  s += Math.max(0, (7 - Math.min(ageDays, 7)) / 7);

  return s;
};

export interface AiSearchResult {
  intent: SearchIntent;
  jobs: IJob[];
  total: number;
  /// 'primary' = matched within the freshness window
  /// 'extended' = freshness dropped, isActive still applied
  /// 'archived' = both freshness and isActive dropped (last-resort)
  /// 'empty' = nothing in the DB matched any of the above
  scope: 'primary' | 'extended' | 'archived' | 'empty';
}

const fetchAndRank = async (
  filter: Record<string, unknown>,
  intent: SearchIntent,
  limit: number,
): Promise<IJob[]> => {
  // Cap candidate pool at 4× the requested limit so the in-memory
  // re-rank stays cheap even when MongoDB returns thousands of matches.
  const candidatePool = Math.max(limit * 4, 60);
  const candidates = await Job.find(filter)
    .sort({ postedAt: -1 })
    .limit(candidatePool)
    .lean<IJob[]>();

  return candidates
    .map((j) => ({ job: j, score: scoreJob(j, intent) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.job);
};

/// End-to-end AI job search:
///   1. Parse the query with Claude (or heuristic) into structured intent
///   2. Build a multi-field MongoDB filter that searches across title,
///      skills, description, responsibilities, department, company
///   3. Fetch a generous candidate pool, score them in-memory, return
///      the top `limit` ranked by relevance
///
/// When the primary filter returns zero hits we cascade through two
/// progressively looser fallbacks before giving up:
///   - drop the freshness window (covers stale-cron environments)
///   - drop the `isActive` flag (covers archived listings)
/// The chosen scope is reflected in [AiSearchResult.scope] so the
/// client can warn the user when they're looking at stale data.
export const aiJobSearch = async ({
  query,
  limit = 30,
  excludeJobIds = [],
}: {
  query: string;
  limit?: number;
  excludeJobIds?: string[];
}): Promise<AiSearchResult> => {
  const intent = await extractSearchIntent(query);

  const primary = await fetchAndRank(
    buildMongoFilter(intent, excludeJobIds),
    intent,
    limit,
  );
  if (primary.length > 0) {
    logger.info(
      `aiJobSearch: "${query.slice(0, 60)}" → ${primary.length} (primary)`,
    );
    return { intent, jobs: primary, total: primary.length, scope: 'primary' };
  }

  const extended = await fetchAndRank(
    buildMongoFilter(intent, excludeJobIds, { dropFreshness: true }),
    intent,
    limit,
  );
  if (extended.length > 0) {
    logger.info(
      `aiJobSearch: "${query.slice(0, 60)}" → ${extended.length} (extended, freshness dropped)`,
    );
    return {
      intent,
      jobs: extended,
      total: extended.length,
      scope: 'extended',
    };
  }

  const archived = await fetchAndRank(
    buildMongoFilter(intent, excludeJobIds, {
      dropFreshness: true,
      dropActive: true,
    }),
    intent,
    limit,
  );
  if (archived.length > 0) {
    logger.info(
      `aiJobSearch: "${query.slice(0, 60)}" → ${archived.length} (archived, all gates dropped)`,
    );
    return {
      intent,
      jobs: archived,
      total: archived.length,
      scope: 'archived',
    };
  }

  logger.info(
    `aiJobSearch: "${query.slice(0, 60)}" → 0 (intent=${JSON.stringify({
      titles: intent.titleKeywords,
      skills: intent.skills,
      roles: intent.roleKeywords,
    })})`,
  );
  return { intent, jobs: [], total: 0, scope: 'empty' };
};
