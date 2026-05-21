"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordCacheHit = exports.generateJson = exports.generate = exports.isProviderEnabled = exports.isAiEnabled = exports.AiProviderQuotaError = exports.AiProviderAuthError = void 0;
const config_service_1 = require("../../config/config.service");
const logger_1 = require("../../../utils/logger");
const gemini_provider_1 = require("./gemini.provider");
const groq_provider_1 = require("./groq.provider");
const usageLog_service_1 = require("../usageLog.service");
const types_1 = require("./types");
var types_2 = require("./types");
Object.defineProperty(exports, "AiProviderAuthError", { enumerable: true, get: function () { return types_2.AiProviderAuthError; } });
Object.defineProperty(exports, "AiProviderQuotaError", { enumerable: true, get: function () { return types_2.AiProviderQuotaError; } });
const ALL_PROVIDER_NAMES = ['gemini', 'groq'];
const providerByName = (name) => {
    if (name === 'groq')
        return groq_provider_1.groqProvider;
    return gemini_provider_1.geminiProvider;
};
const buildProviderChain = (preferred) => {
    const want = preferred ??
        (0, config_service_1.getAppConfig)('AI_PROVIDER') ??
        'gemini';
    const ordered = [want, ...ALL_PROVIDER_NAMES.filter((n) => n !== want)];
    const seen = new Set();
    const chain = [];
    for (const name of ordered) {
        if (seen.has(name))
            continue;
        seen.add(name);
        const p = providerByName(name);
        if (p.enabled)
            chain.push(p);
    }
    return chain;
};
const isAiEnabled = () => gemini_provider_1.geminiProvider.enabled || groq_provider_1.groqProvider.enabled;
exports.isAiEnabled = isAiEnabled;
const isProviderEnabled = (name) => {
    if (name === 'gemini')
        return gemini_provider_1.geminiProvider.enabled;
    return groq_provider_1.groqProvider.enabled;
};
exports.isProviderEnabled = isProviderEnabled;
const generate = async (opts, ctx) => {
    const chain = buildProviderChain(opts.provider);
    if (chain.length === 0) {
        return gemini_provider_1.geminiProvider.generate(opts);
    }
    let lastFallbackError = null;
    for (const provider of chain) {
        const startedAt = Date.now();
        try {
            const result = await provider.generate(opts);
            (0, usageLog_service_1.recordAiUsage)({
                userId: ctx?.userId,
                feature: ctx?.feature ?? 'unknown',
                provider: provider.name,
                tier: opts.tier,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                latencyMs: Date.now() - startedAt,
                success: true,
            });
            return result;
        }
        catch (err) {
            const isQuota = err instanceof types_1.AiProviderQuotaError;
            const isAuth = err instanceof types_1.AiProviderAuthError;
            const isFallbackable = isQuota || isAuth;
            const errorCode = isQuota
                ? 'quota'
                : isAuth
                    ? 'auth'
                    : err?.name ?? 'error';
            (0, usageLog_service_1.recordAiUsage)({
                userId: ctx?.userId,
                feature: ctx?.feature ?? 'unknown',
                provider: provider.name,
                tier: opts.tier,
                latencyMs: Date.now() - startedAt,
                success: false,
                errorCode,
            });
            if (!isFallbackable)
                throw err;
            lastFallbackError = err;
        }
    }
    throw (lastFallbackError ??
        new types_1.AiProviderQuotaError('All AI providers unavailable (quota or auth)'));
};
exports.generate = generate;
const generateJson = async (opts, ctx) => {
    try {
        const res = await (0, exports.generate)({ ...opts, json: true }, ctx);
        const cleaned = res.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        return JSON.parse(cleaned);
    }
    catch (err) {
        if (err instanceof types_1.AiProviderQuotaError)
            throw err;
        if (err instanceof SyntaxError) {
            logger_1.logger.warn(`AI JSON parse failed: ${err.message}`);
            return null;
        }
        throw err;
    }
};
exports.generateJson = generateJson;
const recordCacheHit = (ctx, tier = 'lite') => {
    (0, usageLog_service_1.recordAiUsage)({
        userId: ctx.userId,
        feature: ctx.feature,
        provider: 'gemini',
        tier,
        latencyMs: 0,
        success: true,
        cacheHit: true,
    });
};
exports.recordCacheHit = recordCacheHit;
