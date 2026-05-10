"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CACHE_KEYS = exports.disconnectRedis = exports.connectRedis = exports.redis = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("./env");
const constants_1 = require("./constants");
const logger_1 = require("../utils/logger");
const useTls = env_1.env.REDIS_TLS === 'true';
const redisOpts = {
    host: env_1.env.REDIS_HOST,
    port: env_1.env.REDIS_PORT,
    username: env_1.env.REDIS_USERNAME || undefined,
    password: env_1.env.REDIS_PASSWORD || undefined,
    db: constants_1.REDIS_DB,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 10000,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    ...(useTls ? { tls: { rejectUnauthorized: true } } : {}),
};
exports.redis = new ioredis_1.default(redisOpts);
exports.redis.on('connect', () => logger_1.logger.info('Redis connected'));
exports.redis.on('ready', () => logger_1.logger.info('Redis ready'));
exports.redis.on('error', (err) => logger_1.logger.error('Redis error:', err));
exports.redis.on('close', () => logger_1.logger.warn('Redis connection closed'));
const connectRedis = async () => {
    try {
        await exports.redis.connect();
    }
    catch (error) {
        logger_1.logger.error('Failed to connect to Redis:', error);
        throw error;
    }
};
exports.connectRedis = connectRedis;
const disconnectRedis = async () => {
    await exports.redis.quit();
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
