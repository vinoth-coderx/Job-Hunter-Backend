"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireCsrf = exports.issueCsrfToken = void 0;
const crypto_1 = require("../utils/crypto");
const ApiError_1 = require("../utils/ApiError");
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_COOKIE = 'jh_csrf';
const buildToken = (secret) => {
    const nonce = (0, crypto_1.randomToken)(16);
    const sig = (0, crypto_1.hmacSign)(nonce, secret).slice(0, 32);
    return `${nonce}.${sig}`;
};
const verifyToken = (token, secret) => {
    const [nonce, sig] = token.split('.');
    if (!nonce || !sig)
        return false;
    const expected = (0, crypto_1.hmacSign)(nonce, secret).slice(0, 32);
    return (0, crypto_1.constantTimeEqual)(sig, expected);
};
const issueCsrfToken = (req, res, next) => {
    const secret = req.signedCookies?.[`${TOKEN_COOKIE}_s`] ?? (0, crypto_1.randomToken)(24);
    if (!req.signedCookies?.[`${TOKEN_COOKIE}_s`]) {
        res.cookie(`${TOKEN_COOKIE}_s`, secret, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            signed: true,
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });
    }
    const token = buildToken(secret);
    res.setHeader('X-CSRF-Token', token);
    next();
};
exports.issueCsrfToken = issueCsrfToken;
const requireCsrf = (req, _res, next) => {
    if (SAFE_METHODS.has(req.method))
        return next();
    if (!req.headers.cookie)
        return next();
    const secret = req.signedCookies?.[`${TOKEN_COOKIE}_s`];
    const token = req.headers['x-csrf-token'] || req.body?._csrf;
    if (!secret || !token || !verifyToken(token, secret)) {
        return next(new ApiError_1.ApiError(403, 'Invalid CSRF token'));
    }
    next();
};
exports.requireCsrf = requireCsrf;
