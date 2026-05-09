"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyWebhookSignature = exports.verifyPaymentSignature = exports.fetchRazorpayPayment = exports.fetchRazorpayOrder = exports.createRazorpayOrder = exports.getRazorpayKeyId = exports.resolveRazorpayMode = void 0;
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const ApiError_1 = require("../utils/ApiError");
const logger_1 = require("../utils/logger");
const BASE = 'https://api.razorpay.com';
const resolveRazorpayMode = (requested) => {
    if (env_1.env.NODE_ENV === 'production')
        return 'live';
    if (requested === 'test' && env_1.env.RAZORPAY_TEST_KEY_ID && env_1.env.RAZORPAY_TEST_KEY_SECRET) {
        return 'test';
    }
    return 'live';
};
exports.resolveRazorpayMode = resolveRazorpayMode;
const requireKeys = (mode) => {
    const keyId = mode === 'test' ? env_1.env.RAZORPAY_TEST_KEY_ID : env_1.env.RAZORPAY_KEY_ID;
    const keySecret = mode === 'test' ? env_1.env.RAZORPAY_TEST_KEY_SECRET : env_1.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
        throw ApiError_1.ApiError.internal(`Razorpay ${mode} keys not configured (set RAZORPAY_${mode === 'test' ? 'TEST_' : ''}KEY_ID, RAZORPAY_${mode === 'test' ? 'TEST_' : ''}KEY_SECRET)`);
    }
    return { keyId, keySecret };
};
const getRazorpayKeyId = (mode) => requireKeys(mode).keyId;
exports.getRazorpayKeyId = getRazorpayKeyId;
const createRazorpayOrder = async (params) => {
    const { keyId, keySecret } = requireKeys(params.mode);
    const { amountPaise, currency = 'INR', receipt, notes } = params;
    if (amountPaise < 100) {
        throw ApiError_1.ApiError.badRequest('Amount must be at least 100 paise (₹1)');
    }
    try {
        const res = await axios_1.default.post(`${BASE}/v1/orders`, {
            amount: amountPaise,
            currency,
            receipt,
            notes,
            payment_capture: 1,
        }, {
            auth: { username: keyId, password: keySecret },
            timeout: 12_000,
        });
        return res.data;
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err)) {
            const detail = err.response?.data;
            logger_1.logger.error('Razorpay createOrder failed', detail ?? err.message);
            throw ApiError_1.ApiError.badRequest(typeof detail === 'object' && detail !== null && 'error' in detail
                ? `Razorpay: ${JSON.stringify(detail.error)}`
                : 'Razorpay order creation failed');
        }
        throw err;
    }
};
exports.createRazorpayOrder = createRazorpayOrder;
const fetchRazorpayOrder = async (orderId, mode) => {
    const { keyId, keySecret } = requireKeys(mode);
    try {
        const res = await axios_1.default.get(`${BASE}/v1/orders/${orderId}`, {
            auth: { username: keyId, password: keySecret },
            timeout: 12_000,
        });
        return res.data;
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err)) {
            logger_1.logger.error('Razorpay fetchOrder failed', err.response?.data ?? err.message);
            throw ApiError_1.ApiError.badRequest('Could not fetch Razorpay order');
        }
        throw err;
    }
};
exports.fetchRazorpayOrder = fetchRazorpayOrder;
const fetchRazorpayPayment = async (paymentId, mode) => {
    const { keyId, keySecret } = requireKeys(mode);
    try {
        const res = await axios_1.default.get(`${BASE}/v1/payments/${paymentId}`, {
            auth: { username: keyId, password: keySecret },
            timeout: 12_000,
        });
        return res.data;
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err)) {
            logger_1.logger.error('Razorpay fetchPayment failed', err.response?.data ?? err.message);
            throw ApiError_1.ApiError.badRequest('Could not fetch Razorpay payment');
        }
        throw err;
    }
};
exports.fetchRazorpayPayment = fetchRazorpayPayment;
const verifyPaymentSignature = (params) => {
    const { keySecret } = requireKeys(params.mode);
    const expected = crypto_1.default
        .createHmac('sha256', keySecret)
        .update(`${params.orderId}|${params.paymentId}`)
        .digest('hex');
    if (expected.length !== params.signature.length)
        return false;
    return crypto_1.default.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(params.signature, 'hex'));
};
exports.verifyPaymentSignature = verifyPaymentSignature;
const verifyWebhookSignature = (params) => {
    const expected = crypto_1.default
        .createHmac('sha256', params.webhookSecret)
        .update(params.rawBody)
        .digest('hex');
    if (expected.length !== params.signature.length)
        return false;
    return crypto_1.default.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(params.signature, 'hex'));
};
exports.verifyWebhookSignature = verifyWebhookSignature;
