"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearJobsCache = exports.warmJobsCache = exports.buildAllJobsPayload = void 0;
const Job_1 = require("../models/Job");
const redis_1 = require("../config/redis");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const buildAllJobsPayload = async () => {
    const cutoff = new Date(Date.now() - env_1.env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
    const items = await Job_1.Job.find({ isActive: true, postedAt: { $gte: cutoff } }, { raw: 0 })
        .sort({ postedAt: -1 })
        .lean();
    return {
        success: true,
        data: items,
        meta: {
            total: items.length,
            freshnessDays: env_1.env.JOB_FRESHNESS_DAYS,
            warmedAt: new Date().toISOString(),
        },
    };
};
exports.buildAllJobsPayload = buildAllJobsPayload;
const warmJobsCache = async () => {
    const payload = await (0, exports.buildAllJobsPayload)();
    await redis_1.redis.setex(redis_1.CACHE_KEYS.ALL_JOBS, env_1.env.REDIS_JOB_CACHE_TTL, JSON.stringify(payload));
    logger_1.logger.info(`Warmed ${redis_1.CACHE_KEYS.ALL_JOBS} cache — ${payload.meta.total} jobs, TTL ${env_1.env.REDIS_JOB_CACHE_TTL}s`);
    return { total: payload.meta.total, cachedKey: redis_1.CACHE_KEYS.ALL_JOBS, ttl: env_1.env.REDIS_JOB_CACHE_TTL };
};
exports.warmJobsCache = warmJobsCache;
const clearJobsCache = async () => {
    const keys = await redis_1.redis.keys('jobs:*');
    if (!keys.length)
        return { deletedKeys: 0 };
    const deleted = await redis_1.redis.del(...keys);
    logger_1.logger.info(`Cleared ${deleted} jobs:* cache keys`);
    return { deletedKeys: deleted };
};
exports.clearJobsCache = clearJobsCache;
