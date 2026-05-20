"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runJobFetch = exports.deleteJobSource = exports.updateJobSource = exports.createJobSource = exports.toggleJobSource = exports.getJobSources = void 0;
const zod_1 = require("zod");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const scraperTracker_1 = require("../utils/scraperTracker");
const config_service_1 = require("../services/config/config.service");
const jobScraper_cron_1 = require("../jobs/jobScraper.cron");
const JobSourceConfig_1 = require("../models/JobSourceConfig");
const jobSourceConfig_service_1 = require("../services/jobSourceConfig.service");
const isSourceConfigured = (keyConfigKeys) => {
    if (keyConfigKeys.length === 0)
        return true;
    return keyConfigKeys.every((k) => {
        const v = (0, config_service_1.getAppConfig)(k);
        return typeof v === 'string' && v.length > 0;
    });
};
exports.getJobSources = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const cfgs = await (0, jobSourceConfig_service_1.getJobSourceConfigs)(true);
    const sources = await Promise.all(cfgs.map(async (def) => {
        const stats = await (0, scraperTracker_1.readScraperStats)(def.source);
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
            lastError: stats.lastErrors > 0
                ? `${stats.lastErrors} error(s) in last run`
                : undefined,
            totalJobsAllTime: stats.window.totalJobs > 0 ? stats.window.totalJobs : undefined,
        };
    }));
    res.json({ sources });
});
exports.toggleJobSource = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const source = req.params.source;
    const enabled = Boolean(req.body?.enabled);
    const doc = await JobSourceConfig_1.JobSourceConfig.findOneAndUpdate({ source }, { $set: { enabled } }, { new: true });
    if (!doc)
        throw ApiError_1.ApiError.notFound(`Unknown source: ${source}`);
    (0, jobSourceConfig_service_1.invalidateJobSourceCache)();
    res.json({
        source: doc.source,
        enabled: doc.enabled,
    });
});
const genericSchema = zod_1.z.object({
    endpointUrl: zod_1.z.string().url(),
    httpMethod: zod_1.z.enum(['GET', 'POST']).default('GET'),
    authHeader: zod_1.z.string().optional(),
    authValueConfigKey: zod_1.z.string().optional(),
    authValuePrefix: zod_1.z.string().optional(),
    requestHeaders: zod_1.z.record(zod_1.z.string()).optional(),
    requestBody: zod_1.z.string().optional(),
    responseRootPath: zod_1.z.string(),
    fieldMap: zod_1.z.object({
        title: zod_1.z.string().min(1),
        company: zod_1.z.string().min(1),
        location: zod_1.z.string().optional(),
        description: zod_1.z.string().optional(),
        url: zod_1.z.string().min(1),
        externalId: zod_1.z.string().min(1),
        salary: zod_1.z.string().optional(),
        type: zod_1.z.string().optional(),
        postedAt: zod_1.z.string().optional(),
    }),
    pageParam: zod_1.z.string().optional(),
    pageCount: zod_1.z.number().int().min(1).max(10).default(1),
    rateLimitMs: zod_1.z.number().int().min(0).max(60000).default(0),
});
const createSchema = zod_1.z.object({
    source: zod_1.z
        .string()
        .min(2)
        .max(40)
        .regex(/^[a-z0-9_-]+$/, 'lowercase letters, digits, dash or underscore only'),
    label: zod_1.z.string().min(1).max(80),
    category: zod_1.z.string().min(1).max(80),
    pricing: zod_1.z.enum(['Free', 'Freemium', 'Paid']).default('Free'),
    enabled: zod_1.z.boolean().default(true),
    queries: zod_1.z.array(zod_1.z.string()).max(50).default([]),
    locations: zod_1.z.array(zod_1.z.string()).max(50).default([]),
    notes: zod_1.z.string().max(500).optional(),
    generic: genericSchema,
});
const updateSchema = zod_1.z.object({
    label: zod_1.z.string().min(1).max(80).optional(),
    category: zod_1.z.string().min(1).max(80).optional(),
    pricing: zod_1.z.enum(['Free', 'Freemium', 'Paid']).optional(),
    enabled: zod_1.z.boolean().optional(),
    queries: zod_1.z.array(zod_1.z.string()).max(50).optional(),
    locations: zod_1.z.array(zod_1.z.string()).max(50).optional(),
    notes: zod_1.z.string().max(500).optional(),
    generic: genericSchema.partial().optional(),
});
exports.createJobSource = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        throw ApiError_1.ApiError.badRequest('Invalid source config', parsed.error.format());
    }
    const dup = await JobSourceConfig_1.JobSourceConfig.findOne({ source: parsed.data.source });
    if (dup) {
        throw ApiError_1.ApiError.conflict(`Source "${parsed.data.source}" already exists`);
    }
    const doc = await JobSourceConfig_1.JobSourceConfig.create({
        ...parsed.data,
        type: 'generic',
        keyConfigKeys: parsed.data.generic.authValueConfigKey
            ? [parsed.data.generic.authValueConfigKey]
            : [],
    });
    (0, jobSourceConfig_service_1.invalidateJobSourceCache)();
    res.status(201).json({ source: doc.toJSON() });
});
exports.updateJobSource = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const source = req.params.source;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
        throw ApiError_1.ApiError.badRequest('Invalid update', parsed.error.format());
    }
    const existing = await JobSourceConfig_1.JobSourceConfig.findOne({ source });
    if (!existing)
        throw ApiError_1.ApiError.notFound(`Unknown source: ${source}`);
    const $set = {};
    if (parsed.data.label !== undefined)
        $set.label = parsed.data.label;
    if (parsed.data.category !== undefined)
        $set.category = parsed.data.category;
    if (parsed.data.pricing !== undefined)
        $set.pricing = parsed.data.pricing;
    if (parsed.data.enabled !== undefined)
        $set.enabled = parsed.data.enabled;
    if (parsed.data.queries !== undefined)
        $set.queries = parsed.data.queries;
    if (parsed.data.locations !== undefined)
        $set.locations = parsed.data.locations;
    if (parsed.data.notes !== undefined)
        $set.notes = parsed.data.notes;
    if (parsed.data.generic !== undefined) {
        if (existing.type !== 'generic') {
            throw ApiError_1.ApiError.badRequest(`Source "${source}" is builtin — its REST config can't be edited`);
        }
        const merged = { ...(existing.generic ?? {}), ...parsed.data.generic };
        const reparsed = genericSchema.safeParse(merged);
        if (!reparsed.success) {
            throw ApiError_1.ApiError.badRequest('Invalid generic config after merge', reparsed.error.format());
        }
        $set.generic = reparsed.data;
        $set.keyConfigKeys = reparsed.data.authValueConfigKey
            ? [reparsed.data.authValueConfigKey]
            : [];
    }
    const updated = await JobSourceConfig_1.JobSourceConfig.findOneAndUpdate({ source }, { $set }, { new: true });
    (0, jobSourceConfig_service_1.invalidateJobSourceCache)();
    res.json({ source: updated?.toJSON() });
});
exports.deleteJobSource = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const source = req.params.source;
    const doc = await JobSourceConfig_1.JobSourceConfig.findOne({ source });
    if (!doc)
        throw ApiError_1.ApiError.notFound(`Unknown source: ${source}`);
    if (doc.type === 'builtin') {
        throw ApiError_1.ApiError.badRequest(`Source "${source}" is builtin — disable it instead of deleting`);
    }
    await JobSourceConfig_1.JobSourceConfig.deleteOne({ source });
    (0, jobSourceConfig_service_1.invalidateJobSourceCache)();
    res.json({ deleted: source });
});
exports.runJobFetch = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const requested = Array.isArray(req.body?.sources)
        ? req.body.sources.filter((s) => typeof s === 'string')
        : undefined;
    if (requested && requested.length > 0) {
        const cfgs = await (0, jobSourceConfig_service_1.getJobSourceConfigs)();
        const valid = new Set(cfgs.map((s) => s.source));
        const unknown = requested.filter((s) => !valid.has(s));
        if (unknown.length) {
            throw ApiError_1.ApiError.badRequest(`Unknown source(s): ${unknown.join(', ')}`);
        }
    }
    const startedAt = new Date().toISOString();
    void (0, jobScraper_cron_1.runJobFetchNow)().catch(() => {
    });
    res.json({
        startedAt,
        pipeline: requested && requested.length > 0 ? requested.join(',') : 'all',
    });
});
