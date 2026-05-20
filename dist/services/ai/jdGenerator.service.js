"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateJd = void 0;
const logger_1 = require("../../utils/logger");
const providers_1 = require("./providers");
const SYSTEM_PROMPT = `You write job descriptions for Indian tech recruiters. You produce STRICT JSON only — no prose, no markdown fences.

Schema:
{
  "title": "<final job title, may polish what hirer typed>",
  "description": "<2-4 paragraph description of role, team, impact — third person, recruiter tone>",
  "responsibilities": ["6-10 concrete bullet points, each one short sentence"],
  "requiredSkills": ["6-12 must-have technical skills"],
  "niceToHaveSkills": ["3-6 differentiators"],
  "perks": ["3-6 perks, only generic ones unless hirer mentioned specifics"],
  "screeningQuestions": [
    { "question": "<question>", "type": "text|yes_no|numeric" }
  ]
}

Rules:
- Tone matches the requested toneHint (default professional).
- Don't invent compensation, equity, or specific perks the hirer didn't request.
- requiredSkills should be specific (e.g., "React 18", "PostgreSQL", not "good communication").
- Return exactly 3 screeningQuestions, focused on filtering for the role's must-haves.
- Avoid hype phrases ("rockstar", "ninja", "10x engineer").`;
const asString = (v, max = 400) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const asStringArray = (v, maxItems, itemMax = 200) => {
    if (!Array.isArray(v))
        return [];
    return v
        .map((x) => asString(x, itemMax))
        .filter((s) => s.length > 0)
        .slice(0, maxItems);
};
const validQuestionType = (v) => {
    const s = asString(v, 20);
    if (s === 'yes_no' || s === 'numeric')
        return s;
    return 'text';
};
const sanitize = (raw) => {
    const sqIn = Array.isArray(raw.screeningQuestions) ? raw.screeningQuestions : [];
    return {
        title: asString(raw.title, 200),
        description: asString(raw.description, 8000),
        responsibilities: asStringArray(raw.responsibilities, 12, 300),
        requiredSkills: asStringArray(raw.requiredSkills, 15, 60),
        niceToHaveSkills: asStringArray(raw.niceToHaveSkills, 10, 60),
        perks: asStringArray(raw.perks, 10, 100),
        screeningQuestions: sqIn
            .filter((q) => !!q && typeof q === 'object')
            .map((q) => ({
            question: asString(q.question, 300),
            type: validQuestionType(q.type),
        }))
            .filter((q) => q.question.length > 0)
            .slice(0, 5),
    };
};
const generateJd = async (input) => {
    const role = (input.role || '').trim();
    const company = (input.companyName || '').trim();
    if (role.length < 2 || company.length < 2) {
        logger_1.logger.info('generateJd: role or company too short, skipping');
        return null;
    }
    const userPrompt = `Generate a JD for:
- Role: ${role}
- Company: ${company}
- Experience band: ${input.experienceMinYears ?? '?'} - ${input.experienceMaxYears ?? '?'} years
- Location: ${input.location || 'unspecified'} (${input.remoteType || 'unspecified'})
- Job type: ${input.jobType || 'full-time'}
- Keywords: ${(input.keywords || []).slice(0, 8).join(', ') || 'none'}
- Tone: ${input.toneHint || 'professional'}

Return the JSON now.`;
    const result = await (0, providers_1.generateJson)({
        tier: 'smart',
        system: SYSTEM_PROMPT,
        user: userPrompt,
        maxTokens: 3000,
        temperature: 0.5,
    });
    if (!result)
        return null;
    return sanitize(result);
};
exports.generateJd = generateJd;
