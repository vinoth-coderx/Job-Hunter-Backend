"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.peekCachedScreeningQuestions = exports.generateScreeningQuestions = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const providers_1 = require("./providers");
const cacheKey = (title, description, skills) => {
    const skillsKey = [...skills]
        .map((s) => s.toLowerCase().trim())
        .filter((s) => s.length > 0)
        .sort()
        .slice(0, 30)
        .join(',');
    const descPrefix = (description || '').slice(0, 240).toLowerCase();
    const hash = crypto_1.default
        .createHash('sha256')
        .update(`${title.toLowerCase().trim()}||${skillsKey}||${descPrefix}`)
        .digest('hex')
        .slice(0, 24);
    return `ai:screen:${hash}`;
};
const SYSTEM_PROMPT = `You generate SHORT screening questions a recruiter can ask applicants for a specific job.

RULES:
- Output STRICT JSON only: {"questions": [...]}.
- Generate 3-5 questions. NO MORE.
- Each question is 6-20 words. Plain English, no jargon, no idioms.
- Mix types based on what's useful:
  - "yes_no" for must-haves you can verify quickly (notice period, location, eligibility).
  - "mcq" only when the answer space is genuinely closed (years bands, location preference). Provide 3-4 options.
  - "text" for open-ended qualifiers (why they're interested, biggest project).
- "isRequired" should be true ONLY for the must-have screeners (notice period, location). Default false otherwise.
- DO NOT ask anything illegal or discriminatory (age, marital status, religion, caste, gender).
- DO NOT ask for information already in the resume (years of experience the resume covers, current company).
- DO NOT ask multi-part questions ("X and Y") — split them.
- Output ONLY the JSON, no markdown fences, no prose.

Schema for each item:
{
  "question": "the question text",
  "type": "text" | "mcq" | "yes_no",
  "options": ["..."] | omitted unless type=mcq,
  "isRequired": true | false
}`;
const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object')
        return [];
    const obj = raw;
    if (!Array.isArray(obj.questions))
        return [];
    const out = [];
    for (const item of obj.questions) {
        if (!item || typeof item !== 'object')
            continue;
        const r = item;
        const question = typeof r.question === 'string' ? r.question.trim().slice(0, 500) : '';
        if (question.length < 3)
            continue;
        const t = typeof r.type === 'string' ? r.type : '';
        const type = t === 'mcq' || t === 'yes_no' ? t : 'text';
        let options;
        if (type === 'mcq' && Array.isArray(r.options)) {
            options = r.options
                .map((o) => (typeof o === 'string' ? o.trim() : ''))
                .filter((o) => o.length > 0)
                .slice(0, 10);
            if (options.length < 2) {
                continue;
            }
        }
        out.push({
            question,
            type,
            options,
            isRequired: r.isRequired === true,
        });
        if (out.length >= 5)
            break;
    }
    return out;
};
const heuristicFallback = () => [
    {
        question: 'What is your notice period in days?',
        type: 'text',
        isRequired: true,
    },
    {
        question: 'Are you open to relocating for this role?',
        type: 'yes_no',
        isRequired: false,
    },
];
const generateScreeningQuestions = async (args) => {
    const title = (args.title || '').trim();
    if (title.length < 3) {
        return {
            questions: heuristicFallback(),
            usedAi: false,
            cached: false,
        };
    }
    const ck = cacheKey(title, args.description, args.skills);
    try {
        const cached = await redis_1.redis.get(ck);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return { questions: parsed, usedAi: true, cached: true };
                }
            }
            catch {
            }
        }
    }
    catch (err) {
        logger_1.logger.warn(`screeningQuestions cache read: ${err.message}`);
    }
    const preferred = (0, providers_1.isProviderEnabled)('groq')
        ? 'groq'
        : undefined;
    if (!preferred &&
        !(0, providers_1.isProviderEnabled)('gemini')) {
        return {
            questions: heuristicFallback(),
            usedAi: false,
            cached: false,
        };
    }
    const userPrompt = [
        `Job title: ${title.slice(0, 200)}`,
        args.skills.length > 0
            ? `Required skills: ${args.skills.slice(0, 25).join(', ')}`
            : null,
        `Description (excerpt):\n"""${(args.description || '').slice(0, 2000)}"""`,
        'Return the JSON now.',
    ]
        .filter(Boolean)
        .join('\n\n');
    try {
        const parsed = await (0, providers_1.generateJson)({
            provider: preferred,
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: userPrompt,
            json: true,
            maxTokens: 600,
            temperature: 0.5,
        }, { userId: args.userId, feature: 'screening_questions' });
        const questions = sanitize(parsed);
        if (questions.length === 0) {
            return {
                questions: heuristicFallback(),
                usedAi: false,
                cached: false,
            };
        }
        try {
            await redis_1.redis.setex(ck, 60 * 60 * 24, JSON.stringify(questions));
        }
        catch (err) {
            logger_1.logger.warn(`screeningQuestions cache write: ${err.message}`);
        }
        return { questions, usedAi: true, cached: false };
    }
    catch (err) {
        logger_1.logger.warn(`screeningQuestions failed: ${err.message}`);
        return {
            questions: heuristicFallback(),
            usedAi: false,
            cached: false,
        };
    }
};
exports.generateScreeningQuestions = generateScreeningQuestions;
const peekCachedScreeningQuestions = async (title, description, skills) => {
    if (!title || title.length < 3)
        return null;
    try {
        const cached = await redis_1.redis.get(cacheKey(title, description, skills));
        if (!cached)
            return null;
        return JSON.parse(cached);
    }
    catch {
        return null;
    }
};
exports.peekCachedScreeningQuestions = peekCachedScreeningQuestions;
