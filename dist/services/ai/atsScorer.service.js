"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listRecentAnalyses = exports.hasCachedAnalysis = exports.analyzeResume = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../../utils/logger");
const ResumeAnalysis_1 = require("../../models/ResumeAnalysis");
const providers_1 = require("./providers");
const hashContent = (resumeText, jobId) => crypto_1.default
    .createHash('sha256')
    .update(`${resumeText}\n||\n${jobId ?? ''}`)
    .digest('hex')
    .slice(0, 32);
const asString = (v, max = 300) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const asStringArray = (v, max = 20, itemMax = 80) => {
    if (!Array.isArray(v))
        return [];
    return v
        .map((x) => asString(x, itemMax))
        .filter((s) => s.length > 0)
        .slice(0, max);
};
const VALID_CATEGORIES = [
    'formatting',
    'keywords',
    'experience',
    'skills',
    'contact',
    'other',
];
const VALID_SEVERITIES = ['high', 'medium', 'low'];
const sanitizeIssues = (raw) => {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((x) => typeof x === 'object' && x !== null)
        .slice(0, 12)
        .map((r) => {
        const cat = asString(r.category);
        const sev = asString(r.severity);
        return {
            category: VALID_CATEGORIES.includes(cat) ? cat : 'other',
            severity: VALID_SEVERITIES.includes(sev) ? sev : 'medium',
            message: asString(r.message, 400),
        };
    })
        .filter((x) => x.message.length > 0);
};
const sanitize = (parsed) => {
    const score = typeof parsed?.score === 'number' && Number.isFinite(parsed.score)
        ? Math.max(0, Math.min(100, Math.round(parsed.score)))
        : 0;
    return {
        score,
        matchedSkills: asStringArray(parsed?.matchedSkills, 30, 60),
        missingKeywords: asStringArray(parsed?.missingKeywords, 25, 60),
        strengths: asStringArray(parsed?.strengths, 8, 220),
        weaknesses: asStringArray(parsed?.weaknesses, 8, 220),
        suggestions: asStringArray(parsed?.suggestions, 10, 280),
        formattingIssues: sanitizeIssues(parsed?.formattingIssues),
    };
};
const heuristicAnalysis = (resumeText, user, job) => {
    const text = resumeText.toLowerCase();
    const userSkills = (user.profile.skills ?? []).map((s) => s.toLowerCase());
    const jobSkills = (job?.skills ?? []).map((s) => s.toLowerCase());
    const targetSkills = jobSkills.length > 0 ? jobSkills : userSkills;
    const matched = targetSkills.filter((s) => s.length > 1 && text.includes(s));
    const missing = jobSkills.filter((s) => !text.includes(s));
    const weaknesses = [];
    const suggestions = [];
    const strengths = [];
    const len = resumeText.length;
    let lengthScore = 0;
    if (len < 400) {
        lengthScore = 1;
        weaknesses.push('Resume is far too short — recruiters expect 1–2 pages.');
        suggestions.push('Expand each role with responsibilities and outcomes.');
    }
    else if (len < 800) {
        lengthScore = 4;
        weaknesses.push('Resume is brief; add more detail to each role.');
    }
    else if (len < 1500)
        lengthScore = 8;
    else if (len <= 4500) {
        lengthScore = 12;
        strengths.push('Well-sized content (1–2 pages of detail).');
    }
    else if (len <= 7000)
        lengthScore = 9;
    else {
        lengthScore = 5;
        weaknesses.push('Resume is unusually long; trim to the most relevant 1–2 pages.');
    }
    const hasEmail = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(resumeText);
    const hasPhone = /(\+?\d[\d\s\-()]{8,}\d)/.test(resumeText);
    const hasLink = /(linkedin\.com|github\.com|portfolio|behance|dribbble|https?:\/\/)/i.test(resumeText);
    const contactScore = (hasEmail ? 3 : 0) + (hasPhone ? 3 : 0) + (hasLink ? 2 : 0);
    if (!hasEmail) {
        weaknesses.push('No email address detected.');
        suggestions.push('Add a professional email at the top.');
    }
    if (!hasPhone) {
        weaknesses.push('No phone number detected.');
        suggestions.push('Include a reachable phone number.');
    }
    if (!hasLink)
        suggestions.push('Add a LinkedIn or portfolio URL.');
    const sectionPatterns = [
        ['experience', /\b(experience|work history|employment|professional background)\b/i],
        ['education', /\b(education|degree|university|college|b\.?(?:tech|sc|e)|m\.?(?:tech|sc|s|ba))\b/i],
        ['skills', /\b(skills|technologies|tech stack|technical|tools)\b/i],
        ['summary', /\b(summary|objective|profile|about)\b/i],
        ['projects', /\b(projects?|portfolio|achievements?|certifications?)\b/i],
    ];
    const sectionsDetected = sectionPatterns.filter(([, re]) => re.test(resumeText));
    const sectionScore = Math.min(15, sectionsDetected.length * 3);
    if (sectionsDetected.length >= 4) {
        strengths.push(`${sectionsDetected.length} key sections detected.`);
    }
    else {
        const missingSections = sectionPatterns
            .filter(([name]) => !sectionsDetected.some(([s]) => s === name))
            .map(([name]) => name);
        if (missingSections.length) {
            suggestions.push(`Add missing section(s): ${missingSections.join(', ')}.`);
        }
    }
    const actionVerbs = [
        'built', 'led', 'designed', 'developed', 'launched', 'shipped', 'managed',
        'reduced', 'increased', 'improved', 'created', 'implemented', 'delivered',
        'architected', 'optimized', 'automated', 'scaled', 'migrated', 'owned',
        'mentored', 'spearheaded', 'streamlined', 'engineered', 'integrated',
    ];
    const verbHits = actionVerbs.filter((v) => new RegExp(`\\b${v}\\b`, 'i').test(resumeText));
    let verbScore = 0;
    if (verbHits.length >= 8) {
        verbScore = 12;
        strengths.push('Strong use of action verbs.');
    }
    else if (verbHits.length >= 5)
        verbScore = 8;
    else if (verbHits.length >= 2)
        verbScore = 4;
    else {
        weaknesses.push('Few strong action verbs — bullets sound passive.');
        suggestions.push('Start each bullet with a verb like Built, Led, Reduced, Designed.');
    }
    const percentMatches = (resumeText.match(/\b\d+(?:\.\d+)?\s?%/g) ?? []).length;
    const moneyMatches = (resumeText.match(/[₹$€£]\s?\d/g) ?? []).length;
    const numMatches = (resumeText.match(/\b\d{2,}\b/g) ?? []).length;
    const quantTotal = percentMatches * 2 + moneyMatches * 2 + Math.min(8, numMatches);
    let quantScore = 0;
    if (quantTotal >= 12) {
        quantScore = 15;
        strengths.push('Achievements backed by concrete numbers.');
    }
    else if (quantTotal >= 7)
        quantScore = 10;
    else if (quantTotal >= 3)
        quantScore = 5;
    else {
        weaknesses.push('Achievements lack quantifiable impact.');
        suggestions.push('Add metrics: "reduced load time 40%", "shipped to 50K users", "saved $30K/yr".');
    }
    const lines = resumeText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const bulletLines = lines.filter((l) => /^\s*[•\-*·▪►]/.test(l)).length;
    const bulletRatio = lines.length > 0 ? bulletLines / lines.length : 0;
    let bulletScore = 0;
    if (bulletRatio >= 0.25)
        bulletScore = 8;
    else if (bulletRatio >= 0.12)
        bulletScore = 5;
    else if (bulletLines >= 3)
        bulletScore = 3;
    else {
        weaknesses.push('Resume reads as walls of text — recruiters skim bullets.');
        suggestions.push('Break responsibilities into bulleted lines (one outcome per bullet).');
    }
    const tokens = text.match(/[a-z]{4,}/g) ?? [];
    const uniqueTokens = new Set(tokens);
    const variety = tokens.length > 0 ? uniqueTokens.size / tokens.length : 0;
    let varietyScore = 0;
    if (variety >= 0.55)
        varietyScore = 10;
    else if (variety >= 0.45)
        varietyScore = 7;
    else if (variety >= 0.35)
        varietyScore = 4;
    else
        weaknesses.push('Repetitive wording — vary your verbs and descriptors.');
    let skillScore = 0;
    if (jobSkills.length > 0) {
        const ratio = matched.length / jobSkills.length;
        skillScore = Math.round(ratio * 20);
        if (ratio >= 0.7)
            strengths.push(`Matches ${matched.length}/${jobSkills.length} required skills.`);
        else if (ratio < 0.3)
            weaknesses.push(`Only ${matched.length}/${jobSkills.length} required skills found.`);
    }
    else if (userSkills.length > 0) {
        const ratio = matched.length / userSkills.length;
        skillScore = Math.round(ratio * 14);
        if (ratio >= 0.7)
            strengths.push('Profile skills appear in resume.');
    }
    else {
        skillScore = 6;
    }
    let score = lengthScore +
        contactScore +
        sectionScore +
        verbScore +
        quantScore +
        bulletScore +
        varietyScore +
        skillScore;
    const hashByte = parseInt(crypto_1.default.createHash('md5').update(resumeText).digest('hex').slice(0, 2), 16);
    score += (hashByte % 5) - 2;
    score = Math.max(20, Math.min(95, score));
    if (missing.length > 0) {
        suggestions.push(`Add these in-demand keywords if you have them: ${missing.slice(0, 6).join(', ')}.`);
    }
    return {
        score,
        matchedSkills: matched.length ? matched.slice(0, 20) : userSkills.slice(0, 10),
        missingKeywords: missing.slice(0, 15),
        strengths: strengths.slice(0, 6),
        weaknesses: weaknesses.slice(0, 6),
        suggestions: suggestions.slice(0, 8),
        formattingIssues: [],
    };
};
const buildSystemPrompt = (hasJob) => `You are an ATS (Applicant Tracking System) and senior recruiter. Score a resume on a 0-100 ATS-friendliness + relevance scale and return STRICT JSON only.

${hasJob ? 'Score the resume against the SPECIFIC TARGET JOB provided. Tailor matched/missing keywords to that job\'s requirements.' : 'Score the resume on general ATS best-practices and overall hire-ability across the candidate\'s field.'}

JSON schema:
{
  "score": number (0-100, integer),
  "matchedSkills": ["skills present in resume that match the target / candidate's domain"],
  "missingKeywords": ["important keywords the resume should add (max 15)"],
  "strengths": ["short bullets, 5-15 words each, max 6"],
  "weaknesses": ["short bullets, 5-15 words each, max 6"],
  "suggestions": ["specific actionable improvements, max 8"],
  "formattingIssues": [
    {
      "category": "formatting | keywords | experience | skills | contact | other",
      "severity": "high | medium | low",
      "message": "1-sentence description of the issue"
    }
  ]
}

Rules:
- Output ONLY the JSON, no prose, no markdown fences.
- Be specific and evidence-based. Reference what's actually in the resume.
- Don't invent achievements the candidate didn't list.
- Score breakdown guidance: 90+ = excellent fit, 70-89 = strong, 50-69 = needs work, <50 = significant gaps.
- If the resume text is too short or not a real resume, return score: 10 with weaknesses explaining why.`;
const buildUserPrompt = (resumeText, job) => {
    const truncatedResume = resumeText.slice(0, 14000);
    if (job) {
        const jd = (job.description || '').slice(0, 4000);
        const skills = (job.skills ?? []).slice(0, 30).join(', ');
        return `TARGET JOB
Title: ${job.title}
Required skills: ${skills || '(none listed)'}
Description: ${jd}

CANDIDATE RESUME
${truncatedResume}

Return the JSON now.`;
    }
    return `CANDIDATE RESUME
${truncatedResume}

Return the JSON now.`;
};
const analyzeResume = async (user, resumeText, opts = {}) => {
    const text = (resumeText || '').trim();
    if (text.length < 80) {
        return {
            score: 0,
            matchedSkills: [],
            missingKeywords: [],
            strengths: [],
            weaknesses: ['Resume text is empty or too short to analyse.'],
            suggestions: ['Upload a complete resume so we can score it.'],
            formattingIssues: [],
            usedAi: false,
            cached: false,
            generatedAt: new Date(),
        };
    }
    const userId = user._id.toString();
    const jobId = opts.job?._id?.toString();
    const contentHash = hashContent(text, jobId);
    if (!opts.forceRefresh) {
        const existing = await ResumeAnalysis_1.ResumeAnalysis.findOne({ user: userId, contentHash })
            .sort({ createdAt: -1 })
            .lean();
        if (existing) {
            (0, providers_1.recordCacheHit)({ userId, feature: 'ats_score' });
            return {
                score: existing.score,
                matchedSkills: existing.matchedSkills,
                missingKeywords: existing.missingKeywords,
                strengths: existing.strengths,
                weaknesses: existing.weaknesses,
                suggestions: existing.suggestions,
                formattingIssues: existing.formattingIssues,
                usedAi: existing.usedAi,
                cached: true,
                generatedAt: existing.createdAt,
            };
        }
    }
    if (!(0, providers_1.isAiEnabled)()) {
        const fallback = heuristicAnalysis(text, user, opts.job ?? undefined);
        await ResumeAnalysis_1.ResumeAnalysis.create({
            user: userId,
            job: jobId,
            contentHash,
            ...fallback,
            modelTier: 'lite',
            usedAi: false,
        });
        return { ...fallback, usedAi: false, cached: false, generatedAt: new Date() };
    }
    const system = buildSystemPrompt(!!opts.job);
    const userPrompt = buildUserPrompt(text, opts.job ?? undefined);
    try {
        const parsed = await (0, providers_1.generateJson)({
            tier: 'smart',
            system,
            user: userPrompt,
            maxTokens: 1800,
            temperature: 0.3,
        }, { userId, feature: 'ats_score' });
        if (!parsed) {
            const fallback = heuristicAnalysis(text, user, opts.job ?? undefined);
            await ResumeAnalysis_1.ResumeAnalysis.create({
                user: userId,
                job: jobId,
                contentHash,
                ...fallback,
                modelTier: 'smart',
                usedAi: false,
            });
            return { ...fallback, usedAi: false, cached: false, generatedAt: new Date() };
        }
        const sanitized = sanitize(parsed);
        await ResumeAnalysis_1.ResumeAnalysis.create({
            user: userId,
            job: jobId,
            contentHash,
            ...sanitized,
            modelTier: 'smart',
            usedAi: true,
        });
        return { ...sanitized, usedAi: true, cached: false, generatedAt: new Date() };
    }
    catch (err) {
        logger_1.logger.warn(`atsScorer failed: ${err.message}`);
        const fallback = heuristicAnalysis(text, user, opts.job ?? undefined);
        return { ...fallback, usedAi: false, cached: false, generatedAt: new Date() };
    }
};
exports.analyzeResume = analyzeResume;
const hasCachedAnalysis = async (userId, resumeText, jobId) => {
    const text = (resumeText || '').trim();
    if (text.length < 80)
        return false;
    const contentHash = hashContent(text, jobId);
    const existing = await ResumeAnalysis_1.ResumeAnalysis.exists({ user: userId, contentHash });
    return existing !== null;
};
exports.hasCachedAnalysis = hasCachedAnalysis;
const listRecentAnalyses = async (userId, limit = 10) => {
    const rows = await ResumeAnalysis_1.ResumeAnalysis.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('score job createdAt usedAi modelTier')
        .lean();
    return rows.map((r) => ({
        id: r._id.toString(),
        score: r.score,
        jobId: r.job?.toString(),
        usedAi: r.usedAi,
        modelTier: r.modelTier,
        createdAt: r.createdAt,
    }));
};
exports.listRecentAnalyses = listRecentAnalyses;
