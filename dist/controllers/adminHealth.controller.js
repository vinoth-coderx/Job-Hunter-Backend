"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminHealth = void 0;
const asyncHandler_1 = require("../utils/asyncHandler");
const redis_1 = require("../config/redis");
const dbConnections_1 = require("../config/dbConnections");
const config_service_1 = require("../services/config/config.service");
const AiKey_1 = require("../models/AiKey");
const env_1 = require("../config/env");
const probeMongo = async () => {
    const start = Date.now();
    try {
        const test = (0, dbConnections_1.getConnectionForMode)('test');
        const live = (0, dbConnections_1.getConnectionForMode)('live');
        if (test.readyState !== 1 || live.readyState !== 1) {
            return {
                name: 'mongo',
                state: 'down',
                detail: `test=${test.readyState} live=${live.readyState}`,
            };
        }
        await Promise.all([
            test.db?.admin().ping(),
            live.db?.admin().ping(),
        ]);
        return { name: 'mongo', state: 'ok', latencyMs: Date.now() - start };
    }
    catch (err) {
        return {
            name: 'mongo',
            state: 'down',
            latencyMs: Date.now() - start,
            detail: err.message,
        };
    }
};
const probeRedis = async () => {
    const start = Date.now();
    try {
        if (redis_1.redis.status !== 'ready') {
            return { name: 'redis', state: 'down', detail: `status=${redis_1.redis.status}` };
        }
        const pong = await redis_1.redis.ping();
        return {
            name: 'redis',
            state: pong === 'PONG' ? 'ok' : 'warn',
            latencyMs: Date.now() - start,
        };
    }
    catch (err) {
        return {
            name: 'redis',
            state: 'down',
            latencyMs: Date.now() - start,
            detail: err.message,
        };
    }
};
const probeAi = async () => {
    const count = await AiKey_1.AiKey.countDocuments({ isActive: true });
    if (count === 0) {
        return {
            name: 'ai-providers',
            state: 'warn',
            detail: 'No active AI keys configured',
        };
    }
    return { name: 'ai-providers', state: 'ok', detail: `${count} active key(s)` };
};
const probeConfigKey = (name, key) => {
    const v = (0, config_service_1.getAppConfig)(key);
    if (v && v.length > 0) {
        return { name, state: 'ok', detail: 'value present' };
    }
    return { name, state: 'warn', detail: `${key} not set` };
};
const maskMongoUri = (uri) => {
    try {
        const url = new URL(uri);
        return `${url.protocol}//${url.host}${url.pathname || ''}`;
    }
    catch {
        return '***@unknown';
    }
};
exports.getAdminHealth = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const probes = await Promise.all([
        probeMongo(),
        probeRedis(),
        probeAi(),
        Promise.resolve(probeConfigKey('cloudinary', 'CLOUDINARY_CLOUD_NAME')),
        Promise.resolve(probeConfigKey('firebase', 'FIREBASE_SERVICE_ACCOUNT_JSON')),
        Promise.resolve(probeConfigKey('razorpay', 'RAZORPAY_KEY_ID')),
        Promise.resolve(probeConfigKey('smtp', 'SMTP_USER')),
    ]);
    const downCount = probes.filter((p) => p.state === 'down').length;
    const warnCount = probes.filter((p) => p.state === 'warn').length;
    const overall = downCount > 0 ? 'down' : warnCount > 0 ? 'warn' : 'ok';
    res.json({
        overall,
        probes,
        runtime: {
            nodeEnv: env_1.env.NODE_ENV,
            port: env_1.env.PORT,
            clientUrl: env_1.env.CLIENT_URL,
        },
        bootstrap: {
            mongo: {
                set: Boolean(env_1.env.MONGODB_URI),
                hostMasked: env_1.env.MONGODB_URI ? maskMongoUri(env_1.env.MONGODB_URI) : null,
                prodSet: Boolean(env_1.env.MONGODB_URI_PROD),
            },
            redis: {
                host: env_1.env.REDIS_HOST,
                port: env_1.env.REDIS_PORT,
                usernameSet: Boolean(env_1.env.REDIS_USERNAME),
                passwordSet: Boolean(env_1.env.REDIS_PASSWORD),
            },
            jwt: {
                secretSet: Boolean(env_1.env.JWT_SECRET),
                secretLength: env_1.env.JWT_SECRET?.length ?? 0,
                refreshSet: Boolean(env_1.env.JWT_REFRESH_SECRET),
                refreshLength: env_1.env.JWT_REFRESH_SECRET?.length ?? 0,
            },
            cryptoMasterKey: {
                set: Boolean(env_1.env.CRYPTO_MASTER_KEY),
                length: env_1.env.CRYPTO_MASTER_KEY?.length ?? 0,
            },
        },
        generatedAt: new Date().toISOString(),
    });
});
