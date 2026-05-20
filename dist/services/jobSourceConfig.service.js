"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJobSourceConfig = exports.invalidateJobSourceCache = exports.getJobSourceConfigs = exports.syncBuiltinSources = exports.seedJobSourceConfigs = void 0;
const JobSourceConfig_1 = require("../models/JobSourceConfig");
const scraperTracker_1 = require("../utils/scraperTracker");
const logger_1 = require("../utils/logger");
const purgeRetiredBuiltins = async () => {
    const known = new Set(scraperTracker_1.KNOWN_SCRAPERS.map((d) => d.source));
    const builtins = await JobSourceConfig_1.JobSourceConfig.find({ type: 'builtin' }, { source: 1 }).lean();
    const retired = builtins
        .map((d) => d.source)
        .filter((s) => !known.has(s));
    if (retired.length === 0)
        return;
    const res = await JobSourceConfig_1.JobSourceConfig.deleteMany({
        type: 'builtin',
        source: { $in: retired },
    });
    logger_1.logger.info(`JobSourceConfig: purged ${res.deletedCount} retired builtin(s): ${retired.join(', ')}`);
};
const seedJobSourceConfigs = async () => {
    try {
        const existing = await JobSourceConfig_1.JobSourceConfig.estimatedDocumentCount();
        if (existing > 0) {
            await (0, exports.syncBuiltinSources)();
            await purgeRetiredBuiltins();
            return;
        }
        await JobSourceConfig_1.JobSourceConfig.insertMany(scraperTracker_1.KNOWN_SCRAPERS.map((def) => ({
            source: def.source,
            label: def.label,
            category: def.category,
            pricing: def.pricing,
            type: 'builtin',
            enabled: true,
            keyConfigKeys: def.keyConfigKeys,
            queries: [],
            locations: [],
            notes: def.notes,
        })));
        logger_1.logger.info(`JobSourceConfig: seeded ${scraperTracker_1.KNOWN_SCRAPERS.length} builtin sources`);
    }
    catch (err) {
        logger_1.logger.warn(`JobSourceConfig seed failed: ${err.message}`);
    }
};
exports.seedJobSourceConfigs = seedJobSourceConfigs;
const syncBuiltinSources = async () => {
    const existing = await JobSourceConfig_1.JobSourceConfig.find({}, { source: 1 }).lean();
    const have = new Set(existing.map((d) => d.source));
    const missing = scraperTracker_1.KNOWN_SCRAPERS.filter((d) => !have.has(d.source));
    if (missing.length === 0)
        return;
    await JobSourceConfig_1.JobSourceConfig.insertMany(missing.map((def) => ({
        source: def.source,
        label: def.label,
        category: def.category,
        pricing: def.pricing,
        type: 'builtin',
        enabled: true,
        keyConfigKeys: def.keyConfigKeys,
        queries: [],
        locations: [],
        notes: def.notes,
    })));
    logger_1.logger.info(`JobSourceConfig: synced ${missing.length} new builtin source(s)`);
};
exports.syncBuiltinSources = syncBuiltinSources;
let cache = [];
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30 * 1000;
const getJobSourceConfigs = async (forceRefresh = false) => {
    const now = Date.now();
    if (!forceRefresh && cache.length > 0 && now - cacheLoadedAt < CACHE_TTL_MS) {
        return cache;
    }
    cache = await JobSourceConfig_1.JobSourceConfig.find({}).sort({ type: 1, source: 1 });
    cacheLoadedAt = now;
    return cache;
};
exports.getJobSourceConfigs = getJobSourceConfigs;
const invalidateJobSourceCache = () => {
    cache = [];
    cacheLoadedAt = 0;
};
exports.invalidateJobSourceCache = invalidateJobSourceCache;
const getJobSourceConfig = async (source) => {
    const all = await (0, exports.getJobSourceConfigs)();
    return all.find((d) => d.source === source) ?? null;
};
exports.getJobSourceConfig = getJobSourceConfig;
