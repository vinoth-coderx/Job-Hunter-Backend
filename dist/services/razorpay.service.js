"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyWebhookSignature = exports.verifyPaymentSignature = exports.fetchRazorpayPayment = exports.fetchRazorpayOrder = exports.createRazorpayOrder = exports.getRazorpayKeyId = void 0;
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const config_service_1 = require("./config/config.service");
const ApiError_1 = require("../utils/ApiError");
const logger_1 = require("../utils/logger");
const BASE = 'https://api.razorpay.com';
const requireKeys = () => {
    const keyId = (0, config_service_1.getAppConfig)('RAZORPAY_KEY_ID');
    const keySecret = (0, config_service_1.getAppConfig)('RAZORPAY_KEY_SECRET');
    if (!keyId || !keySecret) {
        throw ApiError_1.ApiError.internal('Razorpay keys not configured (set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET in admin panel or .env)');
    }
    return { keyId, keySecret };
};
const getRazorpayKeyId = () => requireKeys().keyId;
exports.getRazorpayKeyId = getRazorpayKeyId;
const createRazorpayOrder = async (params) => {
    const { keyId, keySecret } = requireKeys();
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
const fetchRazorpayOrder = async (orderId) => {
    const { keyId, keySecret } = requireKeys();
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
const fetchRazorpayPayment = async (paymentId) => {
    const { keyId, keySecret } = requireKeys();
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
    const { keySecret } = requireKeys();
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
