"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiSearchLimiter = exports.scrapeLimiter = exports.authLimiter = exports.generalLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const crypto_1 = require("crypto");
const constants_1 = require("../config/constants");
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
exports.generalLimiter = (0, express_rate_limit_1.default)({
    windowMs: constants_1.RATE_LIMIT_WINDOW_MS,
    max: constants_1.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/' || req.path.endsWith('/health'),
    keyGenerator: tokenAwareKey,
    message: { success: false, message: 'Too many requests. Please try again later.' },
});
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
