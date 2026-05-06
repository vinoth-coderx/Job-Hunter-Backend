"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hash = exports.randomToken = exports.constantTimeEqual = exports.hmacSign = exports.decrypt = exports.encrypt = void 0;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY = crypto_1.default.createHash('sha256').update(env_1.env.JWT_SECRET).digest();
const encrypt = (plain) => {
    const iv = crypto_1.default.randomBytes(IV_LENGTH);
    const cipher = crypto_1.default.createCipheriv(ALGORITHM, KEY, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`;
};
exports.encrypt = encrypt;
const decrypt = (token) => {
    const [ivB64, encB64, tagB64] = token.split('.');
    if (!ivB64 || !encB64 || !tagB64)
        throw new Error('Invalid encrypted payload');
    const iv = Buffer.from(ivB64, 'base64url');
    const enc = Buffer.from(encB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const decipher = crypto_1.default.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
};
exports.decrypt = decrypt;
const hmacSign = (data, secret = env_1.env.JWT_SECRET) => {
    return crypto_1.default.createHmac('sha256', secret).update(data).digest('hex');
};
exports.hmacSign = hmacSign;
const constantTimeEqual = (a, b) => {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length)
        return false;
    return crypto_1.default.timingSafeEqual(bufA, bufB);
};
exports.constantTimeEqual = constantTimeEqual;
const randomToken = (bytes = 32) => crypto_1.default.randomBytes(bytes).toString('base64url');
exports.randomToken = randomToken;
const hash = (text) => crypto_1.default.createHash('sha256').update(text).digest('hex');
exports.hash = hash;
