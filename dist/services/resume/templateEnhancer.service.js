"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enhanceTemplate = exports.scoreTemplate = void 0;
const logger_1 = require("../../utils/logger");
const providers_1 = require("../ai/providers");
const TOKEN_RE = /\{\{\s*[\w.-]+\s*\}\}/g;
const extractTokens = (html) => {
    const set = new Set();
    for (const match of html.matchAll(TOKEN_RE)) {
        set.add(match[0].replace(/\s+/g, ''));
    }
    return set;
};
const stripHtml = (html) => html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const SAMPLE_VALUES = {
    fullname: 'Aarav Sharma',
    firstname: 'Aarav',
    lastname: 'Sharma',
    email: 'aarav.sharma@example.com',
    phone: '+91 98765 43210',
    location: 'Bengaluru, India',
    headline: 'Senior Full-Stack Engineer',
    summary: 'Full-stack engineer with 8 years building scalable web platforms. Led a 6-person team to ship a fintech product that grew to 250K users in 18 months. Reduced infra spend 38% via service consolidation.',
    skills: 'TypeScript, React, Node.js, Postgres, AWS, Docker, Kubernetes, GraphQL, Redis, CI/CD',
    experience: '• Built a real-time analytics dashboard adopted by 1,200+ enterprise users.\n• Reduced API p95 latency from 480ms to 120ms by introducing read replicas and query batching.\n• Mentored 4 junior engineers; 2 promoted within the year.',
    education: 'B.Tech, Computer Science, IIT Madras — 2014 (CGPA 8.6/10).',
    projects: '• Open-source CLI for migrating Mongo collections, 1.2K GitHub stars.\n• Side project: a Tamil-English code-switch translator hitting 92% BLEU.',
    certifications: 'AWS Certified Solutions Architect — Associate (2023).',
    linkedin: 'linkedin.com/in/aarav-sharma',
    github: 'github.com/aarav',
    portfolio: 'aaravsharma.dev',
};
const fillPlaceholders = (html) => html.replace(TOKEN_RE, (token) => {
    const key = token.replace(/[{}\s]/g, '').toLowerCase();
    return SAMPLE_VALUES[key] ?? 'Sample content for ' + key;
});
const heuristicScore = (html) => {
    const text = stripHtml(html);
    const lower = text.toLowerCase();
    const notes = [];
    const len = text.length;
    let length = 0;
    if (len < 600) {
        length = 2;
        notes.push('Template renders very short; add more sample content.');
    }
    else if (len < 1200)
        length = 6;
    else if (len <= 4000)
        length = 12;
    else if (len <= 6500)
        length = 9;
    else {
        length = 5;
        notes.push('Template renders too long; trim filler.');
    }
    const hasEmail = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text);
    const hasPhone = /(\+?\d[\d\s\-()]{8,}\d)/.test(text);
    const hasLink = /(linkedin|github|portfolio|behance|https?:\/\/)/i.test(text);
    const contact = (hasEmail ? 3 : 0) + (hasPhone ? 3 : 0) + (hasLink ? 2 : 0);
    if (!hasEmail)
        notes.push('Filled template has no email field.');
    const sections = [
        /\b(experience|work history)\b/i,
        /\b(education|degree|university)\b/i,
        /\b(skills|technologies)\b/i,
        /\b(summary|profile|objective)\b/i,
        /\b(projects?|certifications?)\b/i,
    ].filter((re) => re.test(text)).length;
    const sectionScore = Math.min(15, sections * 3);
    if (sections < 3)
        notes.push('Add the standard sections (experience, education, skills).');
    const actionVerbs = [
        'built', 'led', 'shipped', 'launched', 'designed', 'developed', 'reduced',
        'increased', 'improved', 'created', 'implemented', 'delivered', 'managed',
        'optimized', 'automated', 'scaled', 'mentored', 'engineered', 'integrated',
    ];
    const verbHits = actionVerbs.filter((v) => new RegExp(`\\b${v}\\b`, 'i').test(lower)).length;
    const verbScore = Math.min(12, verbHits * 1.5);
    if (verbHits < 3)
        notes.push('Sample bullets should lead with action verbs.');
    const numbers = (text.match(/\b\d{2,}\b/g) ?? []).length;
    const percents = (text.match(/\d+%/g) ?? []).length;
    const money = (text.match(/[₹$€£]\s?\d/g) ?? []).length;
    const quantTotal = Math.min(8, numbers) + percents * 2 + money * 2;
    const quantScore = Math.min(15, quantTotal);
    if (quantTotal < 5)
        notes.push('Bullets should be quantified (numbers, %, $).');
    const bullets = (text.match(/[•·▪►\-*]/g) ?? []).length;
    const bulletScore = bullets >= 8 ? 8 : bullets >= 4 ? 5 : 2;
    let structural = 12;
    if (/<table/i.test(html)) {
        structural -= 6;
        notes.push('Avoid <table> for layout — many ATS parsers garble it.');
    }
    if (/<img/i.test(html)) {
        structural -= 3;
        notes.push('Images are ignored by ATS — keep critical info in text.');
    }
    if (/position\s*:\s*absolute/i.test(html)) {
        structural -= 3;
        notes.push('Absolute positioning often re-orders content during PDF parse.');
    }
    structural = Math.max(0, structural);
    const total = Math.round(length + contact + sectionScore + verbScore + quantScore + bulletScore + structural);
    const score = Math.max(20, Math.min(95, total));
    return { score, notes: notes.slice(0, 8), source: 'heuristic' };
};
const scoreTemplate = (html) => {
    const filled = fillPlaceholders(html);
    return heuristicScore(filled);
};
exports.scoreTemplate = scoreTemplate;
const ENHANCER_SYSTEM = `You are a resume design + ATS expert. You are improving an HTML resume template.

Goals:
- Keep the visual layout and styling intact (don't change colours, fonts, or
  the overall structure of sections).
- Improve ATS friendliness: prefer semantic tags (<section>, <h2>, <ul>),
  avoid layout <table>s, prefer flexbox/grid for arrangement.
- Tighten copy where it's lorem-ipsum-ish but DO NOT invent personal data.
- PRESERVE every Mustache placeholder exactly as-is (e.g. {{fullName}},
  {{email}}, {{skills}}). Do not add new placeholders, do not rename them.
- The result must still be a single self-contained HTML document.

Output STRICT JSON only:
{
  "html": "<the improved HTML string>",
  "changes": ["short bullet describing each notable change, max 6"]
}

Rules:
- No markdown fences, no prose outside the JSON.
- If you can't improve the template, return the original HTML and an
  empty changes array.`;
const enhanceWithAi = async (html) => {
    try {
        const parsed = await (0, providers_1.generateJson)({
            tier: 'smart',
            system: ENHANCER_SYSTEM,
            user: `TEMPLATE HTML:\n${html.slice(0, 20000)}\n\nReturn the JSON now.`,
            maxTokens: 6000,
            temperature: 0.25,
        }, { feature: 'resume_template_enhance' });
        if (!parsed || typeof parsed.html !== 'string' || parsed.html.length < 100) {
            return null;
        }
        const changes = Array.isArray(parsed.changes)
            ? parsed.changes
                .filter((c) => typeof c === 'string')
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
                .slice(0, 8)
            : [];
        const before = extractTokens(html);
        const after = extractTokens(parsed.html);
        const warnings = [];
        for (const t of before) {
            if (!after.has(t))
                warnings.push(`AI dropped placeholder ${t}; reverting.`);
        }
        if (warnings.length > 0) {
            logger_1.logger.warn(`Template enhancer: ${warnings.join(' / ')}`);
            return { html, changes: [], usedAi: false, warnings };
        }
        return { html: parsed.html, changes, usedAi: true, warnings: [] };
    }
    catch (err) {
        logger_1.logger.warn(`Template enhancer AI call failed: ${err.message}`);
        return null;
    }
};
const heuristicEnhance = (html) => {
    const changes = [];
    let next = html;
    if (/<table[^>]*>/i.test(next)) {
        next = next.replace(/<table[^>]*>/gi, '<section class="resume-row" role="group">');
        next = next.replace(/<\/table>/gi, '</section>');
        next = next.replace(/<\/?(tbody|thead|tfoot|tr|td|th)[^>]*>/gi, '');
        changes.push('Replaced layout <table> with semantic <section>.');
    }
    if (/style=["'][^"']*position\s*:\s*absolute[^"']*["']/i.test(next)) {
        next = next.replace(/position\s*:\s*absolute\s*;?/gi, '');
        changes.push('Removed absolute positioning (ATS parsers reorder it).');
    }
    if (!/<p[\s>]/i.test(next) && /<div[^>]*>/i.test(next)) {
        changes.push('Note: no <p> tags found — admin should add semantic prose tags.');
    }
    return {
        html: next,
        changes,
        usedAi: false,
        warnings: ['AI provider not configured; only structural cleanup applied.'],
    };
};
const enhanceTemplate = async (html) => {
    if ((0, providers_1.isAiEnabled)()) {
        const ai = await enhanceWithAi(html);
        if (ai)
            return ai;
    }
    return heuristicEnhance(html);
};
exports.enhanceTemplate = enhanceTemplate;
