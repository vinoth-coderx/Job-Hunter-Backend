"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.disable2fa = exports.verifyLoginToken = exports.completeEnrollment = exports.startEnrollment = exports.provisioningUri = exports.verifyTotp = void 0;
const crypto_1 = __importDefault(require("crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const crypto_2 = require("../../utils/crypto");
const User_1 = require("../../models/User");
const ApiError_1 = require("../../utils/ApiError");
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32Encode = (buf) => {
    let bits = 0;
    let value = 0;
    let out = '';
    for (let i = 0; i < buf.length; i++) {
        value = (value << 8) | buf[i];
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
};
const base32Decode = (input) => {
    const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const ch of clean) {
        const idx = BASE32_ALPHABET.indexOf(ch);
        if (idx === -1)
            throw new Error('Invalid base32 character');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
};
const generateSecret = () => base32Encode(crypto_1.default.randomBytes(20));
const hotp = (secret, counter) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(counter);
    const hmac = crypto_1.default.createHmac('sha1', secret).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return (code % 1_000_000).toString().padStart(6, '0');
};
const verifyTotp = (token, base32Secret, windowSteps = 1) => {
    const secret = base32Decode(base32Secret);
    const step = BigInt(Math.floor(Date.now() / 30_000));
    for (let i = -windowSteps; i <= windowSteps; i++) {
        if (hotp(secret, step + BigInt(i)) === token)
            return true;
    }
    return false;
};
exports.verifyTotp = verifyTotp;
const provisioningUri = (account, secret, issuer = 'Job Hunter') => {
    const label = encodeURIComponent(`${issuer}:${account}`);
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: '6',
        period: '30',
    });
    return `otpauth://totp/${label}?${params.toString()}`;
};
exports.provisioningUri = provisioningUri;
const startEnrollment = async (userId) => {
    const user = await User_1.User.findById(userId);
    if (!user)
        throw new ApiError_1.ApiError(404, 'User not found');
    if (user.twoFactor?.enabled)
        throw new ApiError_1.ApiError(400, '2FA already enabled');
    const secret = generateSecret();
    user.twoFactor = {
        enabled: false,
        method: 'totp',
        secretEnc: (0, crypto_2.encrypt)(secret),
        backupCodes: [],
        enrolledAt: undefined,
        lastVerifiedAt: undefined,
    };
    await user.save();
    return { secret, uri: (0, exports.provisioningUri)(user.email, secret) };
};
exports.startEnrollment = startEnrollment;
const generateBackupCodes = (count = 10) => {
    const codes = [];
    for (let i = 0; i < count; i++) {
        codes.push(crypto_1.default.randomBytes(5).toString('hex'));
    }
    return codes;
};
const completeEnrollment = async (userId, token) => {
    const user = await User_1.User.findById(userId).select('+twoFactor.secretEnc');
    if (!user)
        throw new ApiError_1.ApiError(404, 'User not found');
    if (!user.twoFactor?.secretEnc)
        throw new ApiError_1.ApiError(400, '2FA enrollment not started');
    const secret = (0, crypto_2.decrypt)(user.twoFactor.secretEnc);
    if (!(0, exports.verifyTotp)(token, secret))
        throw new ApiError_1.ApiError(400, 'Incorrect code');
    const plain = generateBackupCodes();
    const hashed = await Promise.all(plain.map((c) => bcryptjs_1.default.hash(c, 10)));
    user.twoFactor.enabled = true;
    user.twoFactor.backupCodes = hashed;
    user.twoFactor.enrolledAt = new Date();
    user.twoFactor.lastVerifiedAt = new Date();
    await user.save();
    return { backupCodes: plain };
};
exports.completeEnrollment = completeEnrollment;
const verifyLoginToken = async (userId, token) => {
    const user = await User_1.User.findById(userId).select('+twoFactor.secretEnc +twoFactor.backupCodes');
    if (!user || !user.twoFactor?.enabled || !user.twoFactor.secretEnc)
        return false;
    const secret = (0, crypto_2.decrypt)(user.twoFactor.secretEnc);
    if ((0, exports.verifyTotp)(token, secret)) {
        user.twoFactor.lastVerifiedAt = new Date();
        await user.save();
        return true;
    }
    for (let i = 0; i < user.twoFactor.backupCodes.length; i++) {
        if (await bcryptjs_1.default.compare(token, user.twoFactor.backupCodes[i])) {
            user.twoFactor.backupCodes.splice(i, 1);
            user.twoFactor.lastVerifiedAt = new Date();
            await user.save();
            return true;
        }
    }
    return false;
};
exports.verifyLoginToken = verifyLoginToken;
const disable2fa = async (userId) => {
    const user = await User_1.User.findById(userId);
    if (!user)
        throw new ApiError_1.ApiError(404, 'User not found');
    user.twoFactor = {
        enabled: false,
        method: 'totp',
        secretEnc: undefined,
        backupCodes: [],
        enrolledAt: undefined,
        lastVerifiedAt: undefined,
    };
    await user.save();
};
exports.disable2fa = disable2fa;
