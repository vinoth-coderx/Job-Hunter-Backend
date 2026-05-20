"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.groqProvider = void 0;
const axios_1 = __importDefault(require("axios"));
const config_service_1 = require("../../config/config.service");
const logger_1 = require("../../../utils/logger");
const types_1 = require("./types");
const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL_LITE = 'llama-3.1-8b-instant';
const DEFAULT_MODEL_SMART = 'llama-3.3-70b-versatile';
let cached = null;
const getClient = () => {
    const key = (0, config_service_1.getAppConfig)('GROQ_API_KEY');
    if (!key)
        return null;
    const baseUrl = (0, config_service_1.getAppConfig)('GROQ_BASE_URL') || DEFAULT_BASE_URL;
    if (cached && cached.key === key && cached.baseUrl === baseUrl)
        return cached.client;
    cached = {
        key,
        baseUrl,
        client: axios_1.default.create({
            baseURL: baseUrl,
            timeout: 30_000,
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
        }),
    };
    return cached.client;
};
const modelFor = (tier) => {
    if (tier === 'smart')
        return (0, config_service_1.getAppConfig)('GROQ_MODEL_SMART') || DEFAULT_MODEL_SMART;
    return (0, config_service_1.getAppConfig)('GROQ_MODEL_LITE') || DEFAULT_MODEL_LITE;
};
const isQuotaError = (err) => {
    const ax = err;
    if (ax?.isAxiosError && ax.response?.status === 429)
        return true;
    const msg = err?.message?.toLowerCase() ?? '';
    return msg.includes('rate') || msg.includes('quota') || msg.includes('429');
};
const isAuthError = (err) => {
    const ax = err;
    if (ax?.isAxiosError) {
        const status = ax.response?.status;
        if (status === 401 || status === 403)
            return true;
    }
    const msg = err?.message?.toLowerCase() ?? '';
    return (msg.includes('invalid api key') ||
        msg.includes('invalid_api_key') ||
        msg.includes('unauthorized') ||
        msg.includes(' 401') ||
        msg.includes(' 403'));
};
exports.groqProvider = {
    name: 'groq',
    get enabled() {
        return getClient() !== null;
    },
    async generate(opts) {
        const client = getClient();
        if (!client) {
            throw new Error('Groq provider disabled: GROQ_API_KEY not set');
        }
        const model = modelFor(opts.tier);
        try {
            const body = {
                model,
                messages: [
                    { role: 'system', content: opts.system },
                    {
                        role: 'user',
                        content: opts.json
                            ? `${opts.user}\n\nReturn ONLY the JSON object, no prose, no markdown fences.`
                            : opts.user,
                    },
                ],
                temperature: opts.temperature ?? 0.4,
                max_tokens: opts.maxTokens ?? 2048,
            };
            if (opts.json) {
                body.response_format = { type: 'json_object' };
            }
            const res = await client.post('/chat/completions', body);
            const data = res.data;
            const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
            const text = opts.json
                ? raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
                : raw;
            return {
                text,
                inputTokens: data.usage?.prompt_tokens,
                outputTokens: data.usage?.completion_tokens,
            };
        }
        catch (err) {
            if (isAuthError(err)) {
                logger_1.logger.warn(`Groq auth error (key rejected): ${err.message}`);
                throw new types_1.AiProviderAuthError('Groq API key is invalid or revoked — rotate it in the admin /ai page');
            }
            if (isQuotaError(err)) {
                logger_1.logger.warn(`Groq quota error: ${err.message}`);
                throw new types_1.AiProviderQuotaError('Groq API quota or rate limit reached');
            }
            const ax = err;
            if (ax?.isAxiosError && ax.response?.data?.error?.message) {
                throw new Error(`Groq API error: ${ax.response.data.error.message}`);
            }
            throw err;
        }
    },
};
