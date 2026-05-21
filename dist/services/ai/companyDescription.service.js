"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCompanyDescription = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const promptGuard_service_1 = require("./promptGuard.service");
const cacheKey = (input) => {
    const norm = [
        input.companyName.toLowerCase().trim(),
        (input.industry || '').toLowerCase().trim(),
        (input.sizeBand || '').toLowerCase().trim(),
        (input.hqLocation || '').toLowerCase().trim(),
        (input.whatYouDo || '').toLowerCase().trim(),
        input.toneHint || 'professional',
    ].join('||');
    const hash = crypto_1.default
        .createHash('sha256')
        .update(norm)
        .digest('hex')
        .slice(0, 24);
    return `ai:companydesc:${hash}`;
};
const SYSTEM_PROMPT = `You write the "About" section of a company profile for an Indian job platform. Output STRICT JSON only.

Schema: {"description": "<2-3 paragraphs of plain text, no markdown>"}

Rules:
- 2-3 paragraphs total, ~120-220 words.
- Paragraph 1: who the company is and what they do.
- Paragraph 2: how they work / what makes them distinct (only what the hirer hinted at — never fabricate facts like funding rounds, awards, employee counts, founders).
- Paragraph 3 (optional): a one-line invitation to candidates to apply.
- Tone matches the requested toneHint (default professional).
- Never invent specific numbers, named clients, named investors, or revenue.
- Avoid hype words ("rockstar", "ninja", "unicorn", "world-class", "cutting-edge").
- Plain prose only — no bullets, no markdown, no headings.`;
const generateCompanyDescription = async (input, ctx = {}) => {
    const companyName = (input.companyName || '').trim();
    if (companyName.length < 2) {
        return { description: '', usedAi: false, cached: false };
    }
    const safeWhatYouDo = input.whatYouDo
        ? (0, promptGuard_service_1.cleanPromptText)(input.whatYouDo, 'company_description', ctx.userId).trim()
        : '';
    const safeInput = {
        ...input,
        whatYouDo: safeWhatYouDo,
    };
    const ck = cacheKey(safeInput);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            const parsed = JSON.parse(cached);
            return { description: parsed.description, usedAi: true, cached: true };
        }
    }
    catch (err) {
        logger_1.logger.warn(`companyDescription cache read: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq')
        ? 'groq'
        : undefined;
    if (!preferred &&
        !(0, providers_1.isProviderEnabled)('gemini')) {
        return { description: '', usedAi: false, cached: false };
    }
    const userPrompt = `Generate the About section for:
- Company name: ${companyName}
- Industry: ${input.industry || 'unspecified'}
- Size band: ${input.sizeBand || 'unspecified'}
- HQ location: ${input.hqLocation || 'unspecified'}
- What they do (hirer's words): ${safeWhatYouDo || 'unspecified'}
- Tone: ${input.toneHint || 'professional'}

Return the JSON now.`;
    try {
        const parsed = await (0, providers_1.generateJson)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: userPrompt,
            json: true,
            maxTokens: 700,
            temperature: 0.55,
        }, { userId: ctx.userId, feature: 'company_description' });
        const desc = parsed && typeof parsed.description === 'string'
            ? parsed.description.trim().slice(0, 3000)
            : '';
        if (!desc || desc.length < 50) {
            return { description: '', usedAi: false, cached: false };
        }
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24 * 30, JSON.stringify({ description: desc }));
        }
        catch (err) {
            logger_1.logger.warn(`companyDescription cache write: ${err.message}`);
        }
        return { description: desc, usedAi: true, cached: false };
    }
    catch (err) {
        logger_1.logger.warn(`companyDescription failed: ${err.message}`);
        return { description: '', usedAi: false, cached: false };
    }
};
exports.generateCompanyDescription = generateCompanyDescription;
