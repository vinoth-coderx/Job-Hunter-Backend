"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listConfigRegistry = exports.probeConfig = exports.removeConfig = exports.upsertConfig = exports.listConfig = void 0;
const axios_1 = __importDefault(require("axios"));
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const config_service_1 = require("../services/config/config.service");
const configRegistry_1 = require("../services/config/configRegistry");
const AppConfig_1 = require("../models/AppConfig");
const constants_1 = require("../config/constants");
const logger_1 = require("../utils/logger");
const VALID_CATEGORIES = [
    'job-board',
    'payment',
    'cloudinary',
    'email',
    'firebase',
    'cron',
    'ai',
    'misc',
];
const KEY_REGEX = /^[A-Z][A-Z0-9_]{0,79}$/;
const MANAGED_KEYS = {
    GEMINI_API_KEY: { surface: '/ai page (AiKey routing)', href: '/ai' },
    GROQ_API_KEY: { surface: '/ai page (AiKey routing)', href: '/ai' },
};
const toEntry = (row, updatedAtFallback) => ({
    key: row.key,
    category: row.category,
    isSecret: row.isSecret,
    value: row.isSecret ? undefined : row.preview ?? undefined,
    hasValue: row.hasValue,
    notes: row.notes,
    updatedAt: (row.updatedAt ?? updatedAtFallback ?? new Date()).toISOString(),
    managedBy: MANAGED_KEYS[row.key],
});
exports.listConfig = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const rows = await (0, config_service_1.listAppConfig)();
    res.json({ entries: rows.map((r) => toEntry(r)) });
});
exports.upsertConfig = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { key, category, isSecret, value, notes } = req.body ?? {};
    if (typeof key !== 'string' || !KEY_REGEX.test(key)) {
        throw ApiError_1.ApiError.badRequest('Invalid key. Use UPPER_SNAKE_CASE, must start with a letter, max 80 chars.');
    }
    if (!VALID_CATEGORIES.includes(category)) {
        throw ApiError_1.ApiError.badRequest(`Invalid category. Allowed: ${VALID_CATEGORIES.join(', ')}`);
    }
    if (typeof isSecret !== 'boolean') {
        throw ApiError_1.ApiError.badRequest('isSecret must be a boolean');
    }
    const existing = await AppConfig_1.AppConfig.findOne({ key }).lean();
    if (!existing) {
        if (typeof value !== 'string' || value.length === 0) {
            throw ApiError_1.ApiError.badRequest('Value is required for new config entries.');
        }
    }
    const wantsValueWrite = typeof value === 'string' && value.length > 0;
    if (wantsValueWrite || (!isSecret && existing)) {
        await (0, config_service_1.setAppConfig)({
            key,
            category,
            isSecret,
            value: value ?? '',
            notes: typeof notes === 'string' ? notes : undefined,
            updatedBy: req.user?.id,
        });
    }
    else {
        await AppConfig_1.AppConfig.updateOne({ key }, {
            $set: {
                category,
                isSecret,
                notes,
                updatedBy: req.user?.id,
            },
        });
    }
    const all = await (0, config_service_1.listAppConfig)();
    const saved = all.find((r) => r.key === key);
    if (!saved)
        throw ApiError_1.ApiError.internal('Saved entry vanished');
    res.json(toEntry(saved));
});
exports.removeConfig = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const key = req.params.key;
    if (typeof key !== 'string' || !key)
        throw ApiError_1.ApiError.badRequest('Key is required');
    await (0, config_service_1.deleteAppConfig)(key);
    res.json({ ok: true });
});
const PROBES = {
    ADZUNA_APP_ID: async () => probeAdzuna(),
    ADZUNA_APP_KEY: async () => probeAdzuna(),
    SERPAPI_KEY: async () => {
        const key = (0, config_service_1.getAppConfig)('SERPAPI_KEY');
        if (!key)
            return { ok: false, detail: 'SERPAPI_KEY not set' };
        const r = await axios_1.default.get('https://serpapi.com/account', {
            params: { api_key: key },
            timeout: 8000,
            validateStatus: () => true,
        });
        return r.status === 200
            ? { ok: true, detail: `account ok (plan: ${r.data?.plan_name ?? 'unknown'})` }
            : { ok: false, detail: `serpapi returned ${r.status}: ${truncate(r.data?.error)}` };
    },
    OPENWEBNINJA_API_KEY: async () => {
        const key = (0, config_service_1.getAppConfig)('OPENWEBNINJA_API_KEY');
        if (!key)
            return { ok: false, detail: 'OPENWEBNINJA_API_KEY not set' };
        const r = await axios_1.default.get(constants_1.OPENWEBNINJA_JSEARCH_URL, {
            params: { query: 'developer', num_pages: '1' },
            headers: { 'X-API-Key': key, Accept: '*/*' },
            timeout: 12000,
            validateStatus: () => true,
        });
        return r.status === 200
            ? { ok: true, detail: `JSearch returned ${r.data?.data?.length ?? 0} hits` }
            : { ok: false, detail: `openwebninja returned ${r.status}` };
    },
    RAPIDAPI_KEY: async () => {
        const key = (0, config_service_1.getAppConfig)('RAPIDAPI_KEY');
        if (!key)
            return { ok: false, detail: 'RAPIDAPI_KEY not set' };
        return { ok: true, detail: 'present (legacy fallback — OPENWEBNINJA_API_KEY preferred)' };
    },
    GEMINI_API_KEY: async () => {
        const key = (0, config_service_1.getAppConfig)('GEMINI_API_KEY');
        if (!key)
            return { ok: false, detail: 'GEMINI_API_KEY not set' };
        const r = await axios_1.default.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, { timeout: 8000, validateStatus: () => true });
        return r.status === 200
            ? { ok: true, detail: `gemini ok (${(r.data?.models?.length ?? 0)} models)` }
            : { ok: false, detail: `gemini returned ${r.status}` };
    },
    CLOUDINARY_CLOUD_NAME: async () => probeCloudinary(),
    CLOUDINARY_API_KEY: async () => probeCloudinary(),
    CLOUDINARY_API_SECRET: async () => probeCloudinary(),
    RAZORPAY_KEY_ID: async () => probeRazorpay(),
    RAZORPAY_KEY_SECRET: async () => probeRazorpay(),
    SMTP_USER: async () => probeSmtp(),
    SMTP_PASS: async () => probeSmtp(),
    FIREBASE_SERVICE_ACCOUNT_JSON: async () => {
        const blob = (0, config_service_1.getAppConfig)('FIREBASE_SERVICE_ACCOUNT_JSON');
        if (!blob)
            return { ok: false, detail: 'FIREBASE_SERVICE_ACCOUNT_JSON not set' };
        try {
            const parsed = JSON.parse(blob);
            if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
                return { ok: false, detail: 'JSON missing project_id/client_email/private_key' };
            }
            return { ok: true, detail: `parsed ok (project ${parsed.project_id})` };
        }
        catch (err) {
            return { ok: false, detail: `invalid JSON: ${err.message}` };
        }
    },
    FIREBASE_PROJECT_ID: async () => {
        const id = (0, config_service_1.getAppConfig)('FIREBASE_PROJECT_ID');
        return id
            ? { ok: true, detail: `project_id = ${id}` }
            : { ok: false, detail: 'FIREBASE_PROJECT_ID not set' };
    },
};
const probeAdzuna = async () => {
    const id = (0, config_service_1.getAppConfig)('ADZUNA_APP_ID');
    const key = (0, config_service_1.getAppConfig)('ADZUNA_APP_KEY');
    if (!id || !key)
        return { ok: false, detail: 'ADZUNA_APP_ID / ADZUNA_APP_KEY missing' };
    const r = await axios_1.default.get(`https://api.adzuna.com/v1/api/jobs/${constants_1.ADZUNA_COUNTRY}/search/1`, {
        params: { app_id: id, app_key: key, results_per_page: 1, what: 'developer' },
        timeout: 8000,
        validateStatus: () => true,
    });
    return r.status === 200
        ? { ok: true, detail: `adzuna ok (${r.data?.count ?? '?'} total results)` }
        : { ok: false, detail: `adzuna returned ${r.status}` };
};
const probeCloudinary = async () => {
    const cloudName = (0, config_service_1.getAppConfig)('CLOUDINARY_CLOUD_NAME');
    const apiKey = (0, config_service_1.getAppConfig)('CLOUDINARY_API_KEY');
    const apiSecret = (0, config_service_1.getAppConfig)('CLOUDINARY_API_SECRET');
    if (!cloudName || !apiKey || !apiSecret) {
        return { ok: false, detail: 'Cloudinary credentials incomplete' };
    }
    const r = await axios_1.default.get(`https://api.cloudinary.com/v1_1/${cloudName}/usage`, {
        auth: { username: apiKey, password: apiSecret },
        timeout: 8000,
        validateStatus: () => true,
    });
    return r.status === 200
        ? { ok: true, detail: `cloudinary ok (plan: ${r.data?.plan ?? 'unknown'})` }
        : { ok: false, detail: `cloudinary returned ${r.status}` };
};
const probeRazorpay = async () => {
    const id = (0, config_service_1.getAppConfig)('RAZORPAY_KEY_ID');
    const secret = (0, config_service_1.getAppConfig)('RAZORPAY_KEY_SECRET');
    if (!id || !secret) {
        return { ok: false, detail: 'Razorpay credentials incomplete' };
    }
    const r = await axios_1.default.get('https://api.razorpay.com/v1/orders', {
        params: { count: 1 },
        auth: { username: id, password: secret },
        timeout: 8000,
        validateStatus: () => true,
    });
    return r.status === 200
        ? { ok: true, detail: 'razorpay auth ok' }
        : { ok: false, detail: `razorpay returned ${r.status}` };
};
const probeSmtp = async () => {
    const user = (0, config_service_1.getAppConfig)('SMTP_USER');
    const pass = (0, config_service_1.getAppConfig)('SMTP_PASS');
    if (!user || !pass)
        return { ok: false, detail: 'SMTP_USER / SMTP_PASS missing' };
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        host: constants_1.SMTP_HOST,
        port: constants_1.SMTP_PORT,
        secure: false,
        auth: { user, pass },
    });
    try {
        await transporter.verify();
        return { ok: true, detail: `smtp ok (${constants_1.SMTP_HOST}:${constants_1.SMTP_PORT})` };
    }
    catch (err) {
        return { ok: false, detail: `smtp verify failed: ${err.message}` };
    }
    finally {
        transporter.close();
    }
};
const truncate = (s, max = 80) => {
    if (typeof s !== 'string')
        return '';
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};
exports.probeConfig = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const key = req.params.key;
    if (typeof key !== 'string' || !key)
        throw ApiError_1.ApiError.badRequest('Key is required');
    const start = Date.now();
    const all = await (0, config_service_1.listAppConfig)();
    const row = all.find((r) => r.key === key);
    if (!row)
        throw ApiError_1.ApiError.notFound(`Config "${key}" not found`);
    if (!row.hasValue) {
        res.json({
            ok: false,
            latencyMs: Date.now() - start,
            detail: 'No value stored',
        });
        return;
    }
    const probe = PROBES[key];
    if (!probe) {
        res.json({
            ok: true,
            latencyMs: Date.now() - start,
            detail: 'Value present (no deep probe for this key)',
        });
        return;
    }
    try {
        const result = await probe();
        res.json({
            ok: result.ok,
            latencyMs: Date.now() - start,
            detail: result.detail,
        });
    }
    catch (err) {
        logger_1.logger.warn(`probe ${key} threw: ${err.message}`);
        res.json({
            ok: false,
            latencyMs: Date.now() - start,
            detail: `probe failed: ${err.message}`,
        });
    }
});
exports.listConfigRegistry = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const existing = new Set((await AppConfig_1.AppConfig.find({}, { key: 1 }).lean()).map((r) => r.key));
    res.json({
        entries: configRegistry_1.CONFIG_REGISTRY.map((e) => ({
            key: e.key,
            category: e.category,
            isSecret: e.isSecret,
            description: e.description,
            defaultValue: e.defaultValue,
            usedBy: e.usedBy,
            alreadyConfigured: existing.has(e.key),
        })),
    });
});
