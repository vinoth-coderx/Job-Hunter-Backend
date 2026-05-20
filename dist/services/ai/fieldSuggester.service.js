"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestField = void 0;
const logger_1 = require("../../utils/logger");
const providers_1 = require("./providers");
const profileBlock = (user) => {
    const p = user.profile;
    return [
        `Name: ${p.fullName || '(not set)'}`,
        `Headline: ${p.headline || '(empty)'}`,
        `Experience years: ${p.experienceYears ?? 0}`,
        `Skills: ${(p.skills || []).join(', ') || '(none)'}`,
        `Preferred roles: ${(p.preferredRoles || []).join(', ') || '(none)'}`,
        `Preferred locations: ${(p.preferredLocations || []).join(', ') || '(none)'}`,
        `Preferred job types: ${(p.preferredJobTypes || []).join(', ') || '(none)'}`,
        `Expected min salary: ${p.expectedSalaryMin ? `₹${p.expectedSalaryMin}` : '(not set)'}`,
        `Resume excerpt: ${(p.resumeText || '').slice(0, 1500) || '(none)'}`,
    ].join('\n');
};
const VALID_JOB_TYPES = [
    'full-time',
    'part-time',
    'contract',
    'internship',
    'temporary',
];
const suggestField = async (user, field) => {
    if (!(0, providers_1.isAiEnabled)())
        return null;
    const ctx = profileBlock(user);
    switch (field) {
        case 'headline': {
            const text = await (0, providers_1.generate)({
                tier: 'lite',
                system: 'You write 1-line professional headlines for job seekers. Output ONLY the headline text, no quotes, no preamble, 60-110 chars. Format: "<seniority> <role> · <2-3 specialties>".',
                user: `Candidate profile:\n${ctx}\n\nWrite the headline.`,
                maxTokens: 100,
                temperature: 0.6,
            });
            const v = sanitizeText(text.text, 200);
            return v ? { field, value: v } : null;
        }
        case 'summary': {
            const text = await (0, providers_1.generate)({
                tier: 'lite',
                system: 'You write 2-4 sentence profile summaries for job seekers. Plain prose, third-person, no bullets, no quotes. Highlight specialties + 1-2 strengths grounded in the profile. Never invent skills.',
                user: `Candidate profile:\n${ctx}\n\nWrite the summary.`,
                maxTokens: 250,
                temperature: 0.6,
            });
            const v = sanitizeText(text.text, 1500);
            return v ? { field, value: v } : null;
        }
        case 'skills':
        case 'preferredRoles':
        case 'preferredLocations':
        case 'preferredJobTypes': {
            const parsed = await (0, providers_1.generateJson)({
                tier: 'lite',
                system: listSystemPrompt(field),
                user: `Candidate profile:\n${ctx}\n\nReturn the JSON now.`,
                maxTokens: 400,
                temperature: 0.5,
            });
            if (!parsed)
                return null;
            let arr = Array.isArray(parsed.values) ? parsed.values : [];
            let cleaned = arr
                .map((x) => sanitizeText(String(x), 60))
                .filter((s) => !!s && s.length > 0);
            if (field === 'preferredJobTypes') {
                cleaned = cleaned
                    .map((s) => s.toLowerCase().trim())
                    .filter((s) => VALID_JOB_TYPES.includes(s));
            }
            const existing = new Set((user.profile[field]) ?? []);
            cleaned = cleaned.filter((s) => !Array.from(existing).map((e) => e.toLowerCase()).includes(s.toLowerCase()));
            const cap = field === 'skills' ? 10 : 5;
            cleaned = cleaned.slice(0, cap);
            return cleaned.length > 0 ? { field, values: cleaned } : null;
        }
        case 'experienceYears': {
            const parsed = await (0, providers_1.generateJson)({
                tier: 'lite',
                system: 'From a candidate profile, infer their TOTAL professional years of experience. Output strict JSON: {"years": <integer 0-50>}. If unclear, use the resume excerpt or default to 1.',
                user: `Candidate profile:\n${ctx}\n\nReturn the JSON now.`,
                maxTokens: 60,
                temperature: 0.2,
            });
            const n = typeof parsed?.years === 'number' ? Math.round(parsed.years) : NaN;
            if (!Number.isFinite(n) || n < 0 || n > 50)
                return null;
            return { field, numericValue: n };
        }
        case 'expectedSalary': {
            const parsed = await (0, providers_1.generateJson)({
                tier: 'lite',
                system: 'You suggest a sensible MINIMUM expected annual salary in INR for a candidate based on their experience, skills, and target role. Output strict JSON: {"inrPerYear": <integer>}. Use Indian market rates. Round to nearest 50,000.',
                user: `Candidate profile:\n${ctx}\n\nReturn the JSON now.`,
                maxTokens: 80,
                temperature: 0.3,
            });
            const n = typeof parsed?.inrPerYear === 'number' ? Math.round(parsed.inrPerYear) : NaN;
            if (!Number.isFinite(n) || n <= 0 || n > 50_000_000)
                return null;
            return { field, numericValue: n };
        }
        default:
            logger_1.logger.warn(`suggestField: unsupported field ${field}`);
            return null;
    }
};
exports.suggestField = suggestField;
const sanitizeText = (s, max) => {
    const t = (s || '').trim().replace(/^["']|["']$/g, '');
    return t.slice(0, max);
};
const listSystemPrompt = (field) => {
    const base = 'Output strict JSON: {"values": ["..."]}. No prose, no fences.';
    switch (field) {
        case 'skills':
            return `Suggest 5-10 specific technical skills the candidate should add to their profile, drawn from their resume excerpt and target roles. Prefer concrete tech (e.g., "PostgreSQL", "Flutter", "AWS") over generic ("communication"). Never invent skills the candidate has no signal for. ${base}`;
        case 'preferredRoles':
            return `Suggest 3-5 job titles the candidate should target. Match their experience and skills. Standard market titles (e.g., "Backend Engineer", "Senior Flutter Developer"). ${base}`;
        case 'preferredLocations':
            return `Suggest 3-5 Indian tier-1/2 cities the candidate should target based on their stated location, role, and remote preference. Use canonical names ("Bangalore", "Mumbai"). ${base}`;
        case 'preferredJobTypes':
            return `Pick the 1-3 most appropriate job types from this exact list: full-time, part-time, contract, internship, temporary. Output values lowercase, exactly matching the list. ${base}`;
    }
};
