import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { readScraperStats } from '../utils/scraperTracker';
import { getAppConfig } from '../services/config/config.service';
import { runJobFetchNow } from '../jobs/jobScraper.cron';
import { JobSourceConfig } from '../models/JobSourceConfig';
import {
  getJobSourceConfigs,
  invalidateJobSourceCache,
} from '../services/jobSourceConfig.service';

/**
 * A source is "configured" when every config key it depends on has a
 * value. Keyless sources (Arbeitnow, Puppeteer) are always configured.
 * The admin's explicit `enabled` toggle layers on top: a source can
 * be configured but disabled by an admin.
 */
const isSourceConfigured = (keyConfigKeys: string[]): boolean => {
  if (keyConfigKeys.length === 0) return true;
  return keyConfigKeys.every((k) => {
    const v = getAppConfig(k);
    return typeof v === 'string' && v.length > 0;
  });
};

export const getJobSources = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    const cfgs = await getJobSourceConfigs(true);
    const sources = await Promise.all(
      cfgs.map(async (def) => {
        const stats = await readScraperStats(def.source);
        return {
          name: def.source,
          label: def.label,
          category: def.category,
          pricing: def.pricing,
          type: def.type,
          enabled: def.enabled,
          configured: isSourceConfigured(def.keyConfigKeys),
          keyConfigKeys: def.keyConfigKeys,
          queries: def.queries,
          locations: def.locations,
          notes: def.notes,
          generic: def.type === 'generic' ? def.generic : undefined,
          lastRunAt: stats.lastRunAt ?? undefined,
          lastJobCount: stats.lastJobsFetched || 0,
          lastStatus: stats.lastStatus ?? undefined,
          lastStatusDetail: stats.lastStatusDetail ?? undefined,
          lastError:
            stats.lastErrors > 0
              ? `${stats.lastErrors} error(s) in last run`
              : undefined,
          totalJobsAllTime:
            stats.window.totalJobs > 0 ? stats.window.totalJobs : undefined,
        };
      }),
    );
    res.json({ sources });
  },
);

export const toggleJobSource = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const source = req.params.source;
    const enabled = Boolean(req.body?.enabled);
    const doc = await JobSourceConfig.findOneAndUpdate(
      { source },
      { $set: { enabled } },
      { new: true },
    );
    if (!doc) throw ApiError.notFound(`Unknown source: ${source}`);
    invalidateJobSourceCache();
    res.json({
      source: doc.source,
      enabled: doc.enabled,
    });
  },
);

// ─── Generic source CRUD ────────────────────────────────────────────

const genericSchema = z.object({
  endpointUrl: z.string().url(),
  httpMethod: z.enum(['GET', 'POST']).default('GET'),
  authHeader: z.string().optional(),
  authValueConfigKey: z.string().optional(),
  authValuePrefix: z.string().optional(),
  requestHeaders: z.record(z.string()).optional(),
  requestBody: z.string().optional(),
  responseRootPath: z.string(),
  fieldMap: z.object({
    title: z.string().min(1),
    company: z.string().min(1),
    location: z.string().optional(),
    description: z.string().optional(),
    url: z.string().min(1),
    externalId: z.string().min(1),
    salary: z.string().optional(),
    type: z.string().optional(),
    postedAt: z.string().optional(),
  }),
  pageParam: z.string().optional(),
  pageCount: z.number().int().min(1).max(10).default(1),
  rateLimitMs: z.number().int().min(0).max(60000).default(0),
});

const createSchema = z.object({
  source: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_-]+$/, 'lowercase letters, digits, dash or underscore only'),
  label: z.string().min(1).max(80),
  category: z.string().min(1).max(80),
  pricing: z.enum(['Free', 'Freemium', 'Paid']).default('Free'),
  enabled: z.boolean().default(true),
  queries: z.array(z.string()).max(50).default([]),
  locations: z.array(z.string()).max(50).default([]),
  notes: z.string().max(500).optional(),
  generic: genericSchema,
});

const updateSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  category: z.string().min(1).max(80).optional(),
  pricing: z.enum(['Free', 'Freemium', 'Paid']).optional(),
  enabled: z.boolean().optional(),
  queries: z.array(z.string()).max(50).optional(),
  locations: z.array(z.string()).max(50).optional(),
  notes: z.string().max(500).optional(),
  // Builtins ignore generic edits server-side.
  generic: genericSchema.partial().optional(),
});

export const createJobSource = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ApiError.badRequest('Invalid source config', parsed.error.format());
    }
    const dup = await JobSourceConfig.findOne({ source: parsed.data.source });
    if (dup) {
      throw ApiError.conflict(`Source "${parsed.data.source}" already exists`);
    }

    const doc = await JobSourceConfig.create({
      ...parsed.data,
      type: 'generic',
      keyConfigKeys: parsed.data.generic.authValueConfigKey
        ? [parsed.data.generic.authValueConfigKey]
        : [],
    });
    invalidateJobSourceCache();
    res.status(201).json({ source: doc.toJSON() });
  },
);

export const updateJobSource = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const source = req.params.source;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ApiError.badRequest('Invalid update', parsed.error.format());
    }

    const existing = await JobSourceConfig.findOne({ source });
    if (!existing) throw ApiError.notFound(`Unknown source: ${source}`);

    const $set: Record<string, unknown> = {};
    if (parsed.data.label !== undefined) $set.label = parsed.data.label;
    if (parsed.data.category !== undefined) $set.category = parsed.data.category;
    if (parsed.data.pricing !== undefined) $set.pricing = parsed.data.pricing;
    if (parsed.data.enabled !== undefined) $set.enabled = parsed.data.enabled;
    if (parsed.data.queries !== undefined) $set.queries = parsed.data.queries;
    if (parsed.data.locations !== undefined) $set.locations = parsed.data.locations;
    if (parsed.data.notes !== undefined) $set.notes = parsed.data.notes;

    if (parsed.data.generic !== undefined) {
      if (existing.type !== 'generic') {
        throw ApiError.badRequest(
          `Source "${source}" is builtin — its REST config can't be edited`,
        );
      }
      const merged = { ...(existing.generic ?? {}), ...parsed.data.generic };
      // Re-validate the merged generic block as a whole so partial
      // updates can't leave required fields missing.
      const reparsed = genericSchema.safeParse(merged);
      if (!reparsed.success) {
        throw ApiError.badRequest(
          'Invalid generic config after merge',
          reparsed.error.format(),
        );
      }
      $set.generic = reparsed.data;
      $set.keyConfigKeys = reparsed.data.authValueConfigKey
        ? [reparsed.data.authValueConfigKey]
        : [];
    }

    const updated = await JobSourceConfig.findOneAndUpdate(
      { source },
      { $set },
      { new: true },
    );
    invalidateJobSourceCache();
    res.json({ source: updated?.toJSON() });
  },
);

export const deleteJobSource = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const source = req.params.source;
    const doc = await JobSourceConfig.findOne({ source });
    if (!doc) throw ApiError.notFound(`Unknown source: ${source}`);
    if (doc.type === 'builtin') {
      throw ApiError.badRequest(
        `Source "${source}" is builtin — disable it instead of deleting`,
      );
    }
    await JobSourceConfig.deleteOne({ source });
    invalidateJobSourceCache();
    res.json({ deleted: source });
  },
);

export const runJobFetch = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const requested = Array.isArray(req.body?.sources)
      ? (req.body.sources as unknown[]).filter(
          (s): s is string => typeof s === 'string',
        )
      : undefined;

    if (requested && requested.length > 0) {
      const cfgs = await getJobSourceConfigs();
      const valid = new Set(cfgs.map((s) => s.source));
      const unknown = requested.filter((s) => !valid.has(s));
      if (unknown.length) {
        throw ApiError.badRequest(`Unknown source(s): ${unknown.join(', ')}`);
      }
    }

    const startedAt = new Date().toISOString();
    // fetchAllJobs has no per-source filter today — a "run now" on any
    // specific source dispatches the full pipeline. The scraper tracker
    // surfaces per-source counts so the UI still tells the truth.
    void runJobFetchNow().catch(() => {
      // runJobFetchNow records its own errors via scraperTracker.
    });

    res.json({
      startedAt,
      pipeline: requested && requested.length > 0 ? requested.join(',') : 'all',
    });
  },
);
