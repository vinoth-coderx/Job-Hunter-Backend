"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.claudeProvider = void 0;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const constants_1 = require("../../../config/constants");
const config_service_1 = require("../../config/config.service");
const logger_1 = require("../../../utils/logger");
const types_1 = require("./types");
let cached = null;
const getClient = () => {
    const key = (0, config_service_1.getAppConfig)('ANTHROPIC_API_KEY');
    if (!key)
        return null;
    if (cached && cached.key === key)
        return cached.client;
    cached = { key, client: new sdk_1.default({ apiKey: key }) };
    return cached.client;
};
const modelFor = (tier) => tier === 'smart' ? constants_1.CLAUDE_MODEL_SMART : constants_1.CLAUDE_MODEL_LITE;
const isQuotaError = (err) => {
    const msg = err?.message?.toLowerCase() ?? '';
    const status = err?.status;
    return status === 429 || msg.includes('rate') || msg.includes('quota');
};
const isAuthError = (err) => {
    const msg = err?.message?.toLowerCase() ?? '';
    const status = err?.status;
    return (status === 401 ||
        status === 403 ||
        msg.includes('invalid x-api-key') ||
        msg.includes('authentication_error') ||
        msg.includes('invalid api key'));
};
exports.claudeProvider = {
    name: 'claude',
    get enabled() {
        return getClient() !== null;
    },
    async generate(opts) {
        const client = getClient();
        if (!client) {
            throw new Error('Claude provider disabled: ANTHROPIC_API_KEY not set');
        }
        const model = modelFor(opts.tier);
        const userText = opts.json
            ? `${opts.user}\n\nReturn ONLY the JSON object, no prose, no markdown fences.`
            : opts.user;
        try {
            const res = await client.messages.create({
                model,
                max_tokens: opts.maxTokens ?? 2048,
                temperature: opts.temperature ?? 0.4,
                system: opts.system,
                messages: [{ role: 'user', content: userText }],
            });
            const block = res.content[0];
            const raw = block && block.type === 'text' && typeof block.text === 'string' ? block.text.trim() : '';
            const text = opts.json
                ? raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
                : raw;
            return {
                text,
                inputTokens: res.usage?.input_tokens,
                outputTokens: res.usage?.output_tokens,
            };
        }
        catch (err) {
            if (isAuthError(err)) {
                logger_1.logger.warn(`Claude auth error (key rejected): ${err.message}`);
                throw new types_1.AiProviderAuthError('Claude API key is invalid or revoked — rotate it in the admin /ai page');
            }
            if (isQuotaError(err)) {
                logger_1.logger.warn(`Claude quota error: ${err.message}`);
                throw new types_1.AiProviderQuotaError('Claude API quota or rate limit reached');
            }
            throw err;
        }
    },
};
