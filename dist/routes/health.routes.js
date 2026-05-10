"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const mongoose_1 = __importDefault(require("mongoose"));
const redis_1 = require("../config/redis");
const Job_1 = require("../models/Job");
const env_1 = require("../config/env");
const constants_1 = require("../config/constants");
const router = (0, express_1.Router)();
const startedAt = Date.now();
const formatBytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const checkMongo = async () => {
    const start = Date.now();
    try {
        if (mongoose_1.default.connection.readyState !== 1) {
            return { status: 'down', error: `readyState=${mongoose_1.default.connection.readyState}` };
        }
        await mongoose_1.default.connection.db?.admin().ping();
        return { status: 'up', latencyMs: Date.now() - start };
    }
    catch (err) {
        return { status: 'down', error: err.message };
    }
};
const checkRedis = async () => {
    const start = Date.now();
    try {
        if (redis_1.redis.status !== 'ready') {
            return { status: 'down', error: `status=${redis_1.redis.status}` };
        }
        const pong = await redis_1.redis.ping();
        return { status: pong === 'PONG' ? 'up' : 'degraded', latencyMs: Date.now() - start };
    }
    catch (err) {
        return { status: 'down', error: err.message };
    }
};
router.get('/health', (_req, res) => {
    res.json({
        success: true,
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
});
router.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});
router.get('/health/ready', async (_req, res) => {
    const [mongo, redisCheck] = await Promise.all([checkMongo(), checkRedis()]);
    const allUp = mongo.status === 'up' && redisCheck.status === 'up';
    res.status(allUp ? 200 : 503).json({
        status: allUp ? 'ready' : 'not_ready',
        checks: { mongo, redis: redisCheck },
        timestamp: new Date().toISOString(),
    });
});
router.get('/health/deep', async (_req, res) => {
    const start = Date.now();
    const [mongo, redisCheck] = await Promise.all([checkMongo(), checkRedis()]);
    let jobStats = {};
    try {
        const cutoff = new Date(Date.now() - constants_1.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
        const [total, fresh, latest] = await Promise.all([
            Job_1.Job.estimatedDocumentCount(),
            Job_1.Job.countDocuments({ isActive: true, postedAt: { $gte: cutoff } }),
            Job_1.Job.findOne({}, { fetchedAt: 1 }).sort({ fetchedAt: -1 }).lean(),
        ]);
        jobStats = {
            total,
            freshLast10Days: fresh,
            lastFetchedAt: latest?.fetchedAt ?? null,
        };
    }
    catch (err) {
        jobStats = { error: err.message };
    }
    const mem = process.memoryUsage();
    const allUp = mongo.status === 'up' && redisCheck.status === 'up';
    res.status(allUp ? 200 : 503).json({
        status: allUp ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        checkLatencyMs: Date.now() - start,
        environment: env_1.env.NODE_ENV,
        nodeVersion: process.version,
        pid: process.pid,
        checks: { mongo, redis: redisCheck },
        jobStats,
        memory: {
            rss: formatBytes(mem.rss),
            heapTotal: formatBytes(mem.heapTotal),
            heapUsed: formatBytes(mem.heapUsed),
            external: formatBytes(mem.external),
        },
    });
});
exports.default = router;
