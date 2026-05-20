"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.geminiProvider = void 0;
const genai_1 = require("@google/genai");
const constants_1 = require("../../../config/constants");
const config_service_1 = require("../../config/config.service");
const logger_1 = require("../../../utils/logger");
const types_1 = require("./types");
let cached = null;
const getClient = () => {
    const key = (0, config_service_1.getAppConfig)('GEMINI_API_KEY');
    if (!key)
        return null;
    if (cached && cached.key === key)
        return cached.client;
    cached = { key, client: new genai_1.GoogleGenAI({ apiKey: key }) };
    return cached.client;
};
const modelFor = (tier) => tier === 'smart' ? constants_1.GEMINI_MODEL_SMART : constants_1.GEMINI_MODEL_LITE;
const isQuotaError = (err) => {
    const msg = err?.message?.toLowerCase() ?? '';
    return (msg.includes('quota') ||
        msg.includes('rate limit') ||
        msg.includes('resource_exhausted') ||
        msg.includes('429'));
};
const isAuthError = (err) => {
    const msg = err?.message?.toLowerCase() ?? '';
    return (msg.includes('api key not valid') ||
        msg.includes('api_key_invalid') ||
        msg.includes('permission_denied') ||
        msg.includes('unauthenticated') ||
        msg.includes(' 401') ||
        msg.includes(' 403'));
};
exports.geminiProvider = {
    name: 'gemini',
    get enabled() {
        return getClient() !== null;
    },
    async generate(opts) {
        const client = getClient();
        if (!client) {
            throw new Error('Gemini provider disabled: GEMINI_API_KEY not set');
        }
        const model = modelFor(opts.tier);
        try {
            const res = await client.models.generateContent({
                model,
                contents: opts.user,
                config: {
                    systemInstruction: opts.system,
                    temperature: opts.temperature ?? 0.4,
                    maxOutputTokens: opts.maxTokens ?? 2048,
                    ...(opts.json ? { responseMimeType: 'application/json' } : {}),
                },
            });
            const text = (res.text ?? '').trim();
            const usage = res.usageMetadata;
            return {
                text,
                inputTokens: usage?.promptTokenCount,
                outputTokens: usage?.candidatesTokenCount,
            };
        }
        catch (err) {
            if (isAuthError(err)) {
                logger_1.logger.warn(`Gemini auth error (key rejected): ${err.message}`);
                throw new types_1.AiProviderAuthError('Gemini API key is invalid or revoked — rotate it in the admin /ai page');
            }
            if (isQuotaError(err)) {
                logger_1.logger.warn(`Gemini quota error: ${err.message}`);
                throw new types_1.AiProviderQuotaError('Gemini API quota or rate limit reached');
            }
            throw err;
        }
    },
};
