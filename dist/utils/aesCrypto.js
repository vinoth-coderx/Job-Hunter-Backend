"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCryptoConfigured = exports.maskApiKey = exports.decryptSecret = exports.encryptSecret = void 0;
const crypto_1 = require("crypto");
const env_1 = require("../config/env");
const ApiError_1 = require("./ApiError");
const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const masterKey = () => {
    if (!env_1.env.CRYPTO_MASTER_KEY) {
        throw ApiError_1.ApiError.internal('CRYPTO_MASTER_KEY is not configured. Set a 32-byte hex string in .env to manage AI keys.');
    }
    return Buffer.from(env_1.env.CRYPTO_MASTER_KEY, 'hex');
};
const encryptSecret = (plaintext) => {
    const key = masterKey();
    const iv = (0, crypto_1.randomBytes)(IV_LENGTH);
    const cipher = (0, crypto_1.createCipheriv)(ALGO, key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
};
exports.encryptSecret = encryptSecret;
const decryptSecret = (encoded) => {
    const key = masterKey();
    const parts = encoded.split(':');
    if (parts.length !== 3) {
        throw ApiError_1.ApiError.internal('Corrupted ciphertext (wrong segment count)');
    }
    const [ivHex, tagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
        throw ApiError_1.ApiError.internal('Corrupted ciphertext (bad iv/tag length)');
    }
    const ciphertext = Buffer.from(cipherHex, 'hex');
    const decipher = (0, crypto_1.createDecipheriv)(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);
    return plaintext.toString('utf8');
};
exports.decryptSecret = decryptSecret;
const maskApiKey = (plain) => {
    if (!plain)
        return '';
    if (plain.length <= 12)
        return '*'.repeat(plain.length);
    const head = plain.slice(0, 8);
    const tail = plain.slice(-4);
    return `${head}${'*'.repeat(Math.max(4, plain.length - 12))}${tail}`;
};
exports.maskApiKey = maskApiKey;
const isCryptoConfigured = () => !!env_1.env.CRYPTO_MASTER_KEY;
exports.isCryptoConfigured = isCryptoConfigured;
