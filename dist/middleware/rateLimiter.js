"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiSearchLimiter = exports.scrapeLimiter = exports.authLimiter = exports.createGeneralLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const crypto_1 = require("crypto");
const config_service_1 = require("../services/config/config.service");
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 600;
const positiveInt = (raw, fallback) => {
    if (!raw)
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};
const tokenAwareKey = (req) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        const token = auth.slice('Bearer '.length).trim();
        if (token) {
            return 'tok:' + (0, crypto_1.createHash)('sha256').update(token).digest('hex').slice(0, 24);
        }
    }
    return 'ip:' + (req.ip ?? 'unknown');
};
const createGeneralLimiter = () => {
    const windowMs = positiveInt((0, config_service_1.getAppConfig)('RATE_LIMIT_WINDOW_MS'), DEFAULT_RATE_LIMIT_WINDOW_MS);
    const max = positiveInt((0, config_service_1.getAppConfig)('RATE_LIMIT_MAX_REQUESTS'), DEFAULT_RATE_LIMIT_MAX_REQUESTS);
    return (0, express_rate_limit_1.default)({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => req.path === '/' || req.path.endsWith('/health'),
        keyGenerator: tokenAwareKey,
        message: { success: false, message: 'Too many requests. Please try again later.' },
    });
};
exports.createGeneralLimiter = createGeneralLimiter;
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
});
exports.scrapeLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 5,
    message: { success: false, message: 'Scraping rate limit exceeded.' },
});
exports.aiSearchLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: tokenAwareKey,
    message: {
        success: false,
        message: 'Too many searches in a row. Take a breath and try again in a minute.',
    },
});
