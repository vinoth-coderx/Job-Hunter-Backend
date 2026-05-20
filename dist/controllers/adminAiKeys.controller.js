"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncAiKeysToAppConfig = exports.testAiKey = exports.deleteAiKey = exports.toggleAiKey = exports.updateAiKey = exports.createAiKey = exports.listAiKeys = void 0;
const mongoose_1 = require("mongoose");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const AiKey_1 = require("../models/AiKey");
const aesCrypto_1 = require("../utils/aesCrypto");
const aiKeySync_service_1 = require("../services/ai/aiKeySync.service");
const config_service_1 = require("../services/config/config.service");
const providers_1 = require("../services/ai/providers");
const PROVIDERS = ['gemini', 'claude', 'groq'];
const toResponse = (k) => ({
    _id: k._id.toString(),
    provider: k.provider,
    label: k.label,
    model: k.model,
    baseUrl: k.baseUrl,
    priority: k.priority,
    weight: k.weight,
    tier: k.tier,
    dailyLimit: k.dailyLimit,
    rpmLimit: k.rpmLimit,
    maxTokens: k.maxTokens,
    temperature: k.temperature,
    allowedFeatures: k.allowedFeatures ?? [],
    notes: k.notes,
    isActive: k.isActive,
    usageToday: k.usageToday ?? 0,
    lastUsedAt: k.lastUsedAt?.toISOString(),
    createdAt: k.createdAt.toISOString(),
});
const requireObjectId = (id) => {
    if (typeof id !== 'string' || !mongoose_1.Types.ObjectId.isValid(id)) {
        throw ApiError_1.ApiError.badRequest('Invalid AI key id');
    }
    return new mongoose_1.Types.ObjectId(id);
};
const parseBody = (body, { requireApiKey }) => {
    const out = {};
    if (body.provider !== undefined) {
        if (!PROVIDERS.includes(body.provider)) {
            throw ApiError_1.ApiError.badRequest(`provider must be one of ${PROVIDERS.join(', ')}`);
        }
        out.provider = body.provider;
    }
    if (body.label !== undefined) {
        if (typeof body.label !== 'string' || !body.label.trim()) {
            throw ApiError_1.ApiError.badRequest('label is required');
        }
        out.label = body.label.trim();
    }
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        out.apiKeyEncrypted = (0, aesCrypto_1.encryptSecret)(body.apiKey.trim());
    }
    else if (requireApiKey) {
        throw ApiError_1.ApiError.badRequest('apiKey is required for new entries');
    }
    if (body.model !== undefined) {
        if (typeof body.model !== 'string' || !body.model.trim()) {
            throw ApiError_1.ApiError.badRequest('model is required');
        }
        out.model = body.model.trim();
    }
    if (body.baseUrl !== undefined) {
        out.baseUrl =
            typeof body.baseUrl === 'string' && body.baseUrl.trim()
                ? body.baseUrl.trim()
                : undefined;
    }
    if (body.priority !== undefined) {
        const n = Number(body.priority);
        if (!Number.isFinite(n))
            throw ApiError_1.ApiError.badRequest('priority must be a number');
        out.priority = Math.max(0, n);
    }
    if (body.weight !== undefined) {
        const n = Number(body.weight);
        if (!Number.isFinite(n))
            throw ApiError_1.ApiError.badRequest('weight must be a number');
        out.weight = Math.max(0, n);
    }
    if (body.tier !== undefined) {
        if (body.tier !== 'free' && body.tier !== 'paid') {
            throw ApiError_1.ApiError.badRequest('tier must be "free" or "paid"');
        }
        out.tier = body.tier;
    }
    if (body.dailyLimit !== undefined) {
        const n = Number(body.dailyLimit);
        if (!Number.isFinite(n) || n < 0)
            throw ApiError_1.ApiError.badRequest('dailyLimit must be >= 0');
        out.dailyLimit = n;
    }
    if (body.rpmLimit !== undefined) {
        const n = Number(body.rpmLimit);
        if (!Number.isFinite(n) || n < 0)
            throw ApiError_1.ApiError.badRequest('rpmLimit must be >= 0');
        out.rpmLimit = n;
    }
    if (body.maxTokens !== undefined) {
        out.maxTokens =
            body.maxTokens === null || body.maxTokens === ''
                ? undefined
                : Number(body.maxTokens);
    }
    if (body.temperature !== undefined) {
        out.temperature =
            body.temperature === null || body.temperature === ''
                ? undefined
                : Number(body.temperature);
    }
    if (body.allowedFeatures !== undefined) {
        if (!Array.isArray(body.allowedFeatures)) {
            throw ApiError_1.ApiError.badRequest('allowedFeatures must be an array of strings');
        }
        out.allowedFeatures = body.allowedFeatures.filter((f) => typeof f === 'string');
    }
    if (body.notes !== undefined) {
        out.notes =
            typeof body.notes === 'string' && body.notes.trim()
                ? body.notes.trim()
                : undefined;
    }
    if (body.isActive !== undefined) {
        out.isActive = Boolean(body.isActive);
    }
    return out;
};
exports.listAiKeys = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const keys = await AiKey_1.AiKey.find({})
        .sort({ priority: 1, createdAt: -1 })
        .lean();
    res.json({ keys: keys.map((k) => toResponse(k)) });
});
exports.createAiKey = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const parsed = parseBody(req.body ?? {}, { requireApiKey: true });
    if (!parsed.provider || !parsed.label || !parsed.model) {
        throw ApiError_1.ApiError.badRequest('provider, label and model are required');
    }
    const created = await AiKey_1.AiKey.create({
        ...parsed,
        createdBy: req.user?._id,
    });
    await (0, aiKeySync_service_1.syncProviderToAppConfig)(created.provider);
    const lean = created.toObject();
    res.json(toResponse(lean));
});
exports.updateAiKey = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const parsed = parseBody(req.body ?? {}, { requireApiKey: false });
    if (Object.keys(parsed).length === 0) {
        throw ApiError_1.ApiError.badRequest('No updatable fields supplied');
    }
    const before = await AiKey_1.AiKey.findById(id).lean();
    const updated = await AiKey_1.AiKey.findByIdAndUpdate(id, parsed, {
        new: true,
    }).lean();
    if (!updated)
        throw ApiError_1.ApiError.notFound('AI key not found');
    await (0, aiKeySync_service_1.syncProviderToAppConfig)(updated.provider);
    if (before && before.provider !== updated.provider) {
        await (0, aiKeySync_service_1.syncProviderToAppConfig)(before.provider);
    }
    res.json(toResponse(updated));
});
exports.toggleAiKey = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const { isActive } = req.body ?? {};
    if (typeof isActive !== 'boolean') {
        throw ApiError_1.ApiError.badRequest('isActive must be a boolean');
    }
    const updated = await AiKey_1.AiKey.findByIdAndUpdate(id, { isActive }, { new: true }).lean();
    if (!updated)
        throw ApiError_1.ApiError.notFound('AI key not found');
    await (0, aiKeySync_service_1.syncProviderToAppConfig)(updated.provider);
    res.json(toResponse(updated));
});
exports.deleteAiKey = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const doomed = await AiKey_1.AiKey.findById(id).lean();
    const r = await AiKey_1.AiKey.deleteOne({ _id: id });
    if (r.deletedCount === 0)
        throw ApiError_1.ApiError.notFound('AI key not found');
    if (doomed)
        await (0, aiKeySync_service_1.syncProviderToAppConfig)(doomed.provider);
    res.json({ ok: true });
});
exports.testAiKey = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const k = await AiKey_1.AiKey.findById(id).select('+apiKeyEncrypted').lean();
    if (!k)
        throw ApiError_1.ApiError.notFound('AI key not found');
    let apiKey;
    try {
        apiKey = (0, aesCrypto_1.decryptSecret)(k.apiKeyEncrypted);
    }
    catch {
        res.json({ ok: false, detail: 'Stored key is corrupt or master key changed' });
        return;
    }
    const start = Date.now();
    try {
        if (k.provider === 'gemini') {
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, { method: 'GET' });
            const ok = resp.ok;
            if (!ok) {
                const body = await resp.text().catch(() => '');
                res.json({
                    ok: false,
                    latencyMs: Date.now() - start,
                    detail: `${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 120)}` : ''}`,
                });
                return;
            }
            res.json({ ok: true, latencyMs: Date.now() - start });
            return;
        }
        if (k.provider === 'groq') {
            const base = (k.baseUrl?.trim() || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
            const resp = await fetch(`${base}/models`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            if (!resp.ok) {
                const body = await resp.text().catch(() => '');
                res.json({
                    ok: false,
                    latencyMs: Date.now() - start,
                    detail: `${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 120)}` : ''}`,
                });
                return;
            }
            res.json({ ok: true, latencyMs: Date.now() - start });
            return;
        }
        const resp = await fetch('https://api.anthropic.com/v1/models', {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            res.json({
                ok: false,
                latencyMs: Date.now() - start,
                detail: `${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 120)}` : ''}`,
            });
            return;
        }
        res.json({ ok: true, latencyMs: Date.now() - start });
    }
    catch (err) {
        res.json({
            ok: false,
            latencyMs: Date.now() - start,
            detail: err.message,
        });
    }
});
exports.syncAiKeysToAppConfig = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    await (0, aiKeySync_service_1.syncAllProvidersToAppConfig)();
    const APP_CFG = {
        gemini: 'GEMINI_API_KEY',
        claude: 'ANTHROPIC_API_KEY',
        groq: 'GROQ_API_KEY',
    };
    const report = { gemini: {}, claude: {}, groq: {} };
    for (const p of PROVIDERS) {
        const [keyRowsTotal, activeRows] = await Promise.all([
            AiKey_1.AiKey.countDocuments({ provider: p }),
            AiKey_1.AiKey.countDocuments({ provider: p, isActive: true }),
        ]);
        report[p] = {
            keyRowsTotal,
            activeRows,
            syncedToAppConfig: Boolean((0, config_service_1.getAppConfig)(APP_CFG[p])),
            providerEnabled: (0, providers_1.isProviderEnabled)(p),
        };
    }
    res.json({ ok: true, report });
});
