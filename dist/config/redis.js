"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CACHE_KEYS = exports.disconnectRedis = exports.connectRedis = exports.redis = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("./env");
const constants_1 = require("./constants");
const dbConnections_1 = require("./dbConnections");
const logger_1 = require("../utils/logger");
const useTls = env_1.env.REDIS_TLS === 'true';
const sharedOpts = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 10000,
    retryStrategy: (times) => Math.min(times * 200, 5000),
};
const buildClient = (mode) => {
    const url = mode === 'live' ? env_1.env.REDIS_URL_LIVE : env_1.env.REDIS_URL_TEST;
    if (url) {
        logger_1.logger.info(`Redis[${mode}]: using REDIS_URL_${mode.toUpperCase()}`);
        return new ioredis_1.default(url, sharedOpts);
    }
    return new ioredis_1.default({
        ...sharedOpts,
        host: env_1.env.REDIS_HOST,
        port: env_1.env.REDIS_PORT,
        username: env_1.env.REDIS_USERNAME || undefined,
        password: env_1.env.REDIS_PASSWORD || undefined,
        db: constants_1.REDIS_DB,
        ...(useTls ? { tls: { rejectUnauthorized: true } } : {}),
    });
};
const clients = {
    test: buildClient('test'),
    live: buildClient('live'),
};
['test', 'live'].forEach((mode) => {
    const c = clients[mode];
    c.on('connect', () => logger_1.logger.info(`Redis[${mode}] connected`));
    c.on('ready', () => logger_1.logger.info(`Redis[${mode}] ready`));
    c.on('error', (err) => logger_1.logger.error(`Redis[${mode}] error:`, err));
    c.on('close', () => logger_1.logger.warn(`Redis[${mode}] connection closed`));
});
const resolveClient = () => clients[(0, dbConnections_1.currentRuntimeMode)()];
const handler = {
    get(_target, prop) {
        const c = resolveClient();
        const value = Reflect.get(c, prop, c);
        if (typeof value === 'function')
            return value.bind(c);
        return value;
    },
    set(_target, prop, value) {
        const c = resolveClient();
        return Reflect.set(c, prop, value);
    },
    has(_target, prop) {
        const c = resolveClient();
        return Reflect.has(c, prop);
    },
};
exports.redis = new Proxy(clients.live, handler);
const connectRedis = async () => {
    await Promise.all([clients.test.connect(), clients.live.connect()]).catch((err) => {
        logger_1.logger.error('Failed to connect to one or more Redis clients:', err);
        throw err;
    });
};
exports.connectRedis = connectRedis;
const disconnectRedis = async () => {
    await Promise.all([clients.test.quit(), clients.live.quit()]);
};
exports.disconnectRedis = disconnectRedis;
exports.CACHE_KEYS = {
    ALL_JOBS: 'jobs:all',
    JOBS_BY_QUERY: (q) => `jobs:query:${q}`,
    USER_MATCHED_JOBS: (userId) => `jobs:user:${userId}:matched`,
    JOB_BY_ID: (id) => `job:${id}`,
    USER_PROFILE: (userId) => `user:${userId}:profile`,
    RATE_LIMIT: (ip) => `rl:${ip}`,
};
