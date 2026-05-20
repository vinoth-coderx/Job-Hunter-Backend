"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectSuspiciousActivity = exports.slowDownAfterFailures = exports.securityHeaders = exports.requireSignedRequest = exports.clearFailedLogins = exports.isLockedOut = exports.recordFailedLogin = void 0;
const ApiError_1 = require("../utils/ApiError");
const redis_1 = require("../config/redis");
const crypto_1 = require("../utils/crypto");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const FAILED_LOGIN_LIMIT = 6;
const FAILED_LOGIN_WINDOW_SEC = 15 * 60;
const LOCKOUT_SEC = 30 * 60;
const recordFailedLogin = async (key) => {
    const k = `lockout:${(0, crypto_1.hash)(key)}`;
    const count = await redis_1.redis.incr(k);
    if (count === 1)
        await redis_1.redis.expire(k, FAILED_LOGIN_WINDOW_SEC);
    if (count >= FAILED_LOGIN_LIMIT) {
        await redis_1.redis.expire(k, LOCKOUT_SEC);
        return { locked: true, remaining: 0 };
    }
    return { locked: false, remaining: FAILED_LOGIN_LIMIT - count };
};
exports.recordFailedLogin = recordFailedLogin;
const isLockedOut = async (key) => {
    const k = `lockout:${(0, crypto_1.hash)(key)}`;
    const count = parseInt((await redis_1.redis.get(k)) || '0', 10);
    return count >= FAILED_LOGIN_LIMIT;
};
exports.isLockedOut = isLockedOut;
const clearFailedLogins = async (key) => {
    await redis_1.redis.del(`lockout:${(0, crypto_1.hash)(key)}`);
};
exports.clearFailedLogins = clearFailedLogins;
const requireSignedRequest = async (req, _res, next) => {
    try {
        if (env_1.env.NODE_ENV === 'development' && !req.headers['x-signature'])
            return next();
        const signature = req.headers['x-signature'];
        const timestamp = req.headers['x-timestamp'];
        const nonce = req.headers['x-nonce'];
        if (!signature || !timestamp || !nonce) {
            throw ApiError_1.ApiError.unauthorized('Missing signature headers');
        }
        const ts = parseInt(timestamp, 10);
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
            throw ApiError_1.ApiError.unauthorized('Stale or invalid timestamp');
        }
        const nonceKey = `nonce:${nonce}`;
        const seen = await redis_1.redis.set(nonceKey, '1', 'EX', 600, 'NX');
        if (!seen)
            throw ApiError_1.ApiError.unauthorized('Nonce reuse detected');
        const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '';
        const payload = `${req.method}\n${req.originalUrl}\n${timestamp}\n${nonce}\n${body}`;
        const expected = (0, crypto_1.hmacSign)(payload);
        if (!(0, crypto_1.constantTimeEqual)(signature, expected)) {
            throw ApiError_1.ApiError.unauthorized('Invalid signature');
        }
        next();
    }
    catch (err) {
        next(err);
    }
};
exports.requireSignedRequest = requireSignedRequest;
const securityHeaders = (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');
    next();
};
exports.securityHeaders = securityHeaders;
const slowDownAfterFailures = async (req, _res, next) => {
    try {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const k = `slowdown:${(0, crypto_1.hash)(ip)}`;
        const count = parseInt((await redis_1.redis.get(k)) || '0', 10);
        if (count > 3) {
            const delayMs = Math.min(2000, count * 250);
            await new Promise((r) => setTimeout(r, delayMs));
        }
        next();
    }
    catch (err) {
        logger_1.logger.warn('slowDown middleware error', err);
        next();
    }
};
exports.slowDownAfterFailures = slowDownAfterFailures;
const BODY_SCAN_BYPASS_PREFIXES = [
    '/api/v1/admin/resume-templates',
];
const detectSuspiciousActivity = (req, _res, next) => {
    const ua = req.headers['user-agent'] || '';
    const url = req.originalUrl;
    const decodedUrl = decodeURIComponent(url);
    const suspicious = [
        /\.\.\//,
        /(union\s+select|or\s+1=1|--\s|\/\*)/i,
        /<script\b/i,
        /(eval|exec|system)\s*\(/i,
        /\$where|\$ne|\$gt|\$regex/,
    ];
    const scanBody = !BODY_SCAN_BYPASS_PREFIXES.some((p) => decodedUrl.startsWith(p));
    const body = scanBody ? JSON.stringify(req.body || {}) : '';
    if (suspicious.some((re) => re.test(decodedUrl) || (scanBody && re.test(body)))) {
        logger_1.logger.warn(`Suspicious request blocked from ${req.ip} ua="${ua}" url="${url}"`);
        return next(ApiError_1.ApiError.badRequest('Request blocked'));
    }
    next();
};
exports.detectSuspiciousActivity = detectSuspiciousActivity;
