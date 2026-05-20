"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiEnhanceTemplateContent = void 0;
const crypto_1 = __importDefault(require("crypto"));
const redis_1 = require("../../config/redis");
const logger_1 = require("../../utils/logger");
const providers_1 = require("../ai/providers");
const aiKeySync_service_1 = require("../ai/aiKeySync.service");
const FEATURE = 'resume_template_fill';
const CACHE_TTL_SEC = 60 * 60 * 24;
const SYSTEM_PROMPT = `You are a professional resume writer specialising in ATS-optimised tech resumes.

Given a seeker's structured profile, produce an enhanced version of the same data formatted into resume-ready HTML fragments.

RULES:
1. NEVER invent facts. If a section is empty, return an empty string for that slot.
2. Quantify outcomes only when the seeker provided numbers; never fabricate percentages or revenue figures.
3. Use action verbs to open bullets (Built, Shipped, Reduced, Led, Architected, Migrated).
4. Keep each bullet ≤ 22 words.
5. HTML must be inline-safe: <div>, <strong>, <em>, <br>, <ul>, <li> only. No <html>, <head>, <script>, <style>.
6. Always escape & < > inside content.
7. Output STRICT JSON matching the schema below. No markdown, no commentary.

JSON SCHEMA (all keys required, string values; empty string when the source has no data):
{
  "summary": "...3 sentence professional summary...",
  "experience": "HTML: <div><strong>Role</strong> · Company<br><em>Period</em><ul><li>bullet</li>...</ul></div><br>...",
  "education": "HTML: <div><strong>Degree</strong>, Institute (Period)</div><br>...",
  "projects": "HTML: <div><strong>Title</strong> — Description</div><br>...",
  "certifications": "Cert A — Issuer (Year); Cert B — Issuer (Year)",
  "skills": "comma-separated, grouped by domain: e.g. Frontend: React, Next.js; Backend: Node.js, Express; ..."
}`;
const buildUserPrompt = (user) => {
    const p = user.profile ?? {};
    const rp = p.resumeProfile;
    const payload = {
        fullName: p.fullName,
        headline: p.headline,
        experienceYears: p.experienceYears ?? 0,
        skills: p.skills ?? [],
        resumeText: (p.resumeText || '').slice(0, 4000),
        preferredRoles: p.preferredRoles ?? [],
        preferredLocations: p.preferredLocations ?? [],
        profileSummary: rp?.profileSummary || '',
        employments: rp?.employments ?? [],
        educations: rp?.educations ?? [],
        projects: rp?.projects ?? [],
        accomplishments: rp?.accomplishments ?? [],
        itSkills: (rp?.itSkills ?? []).map((s) => ({
            skill: s.skill,
            experience: s.experience,
        })),
        careerProfile: rp?.careerProfile ?? null,
    };
    return [
        'Seeker profile (JSON):',
        JSON.stringify(payload, null, 2),
        '',
        'Return the 6-key JSON described in the system prompt.',
    ].join('\n');
};
const sanitize = (raw) => ({
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
    experience: typeof raw?.experience === 'string' ? raw.experience : '',
    education: typeof raw?.education === 'string' ? raw.education : '',
    projects: typeof raw?.projects === 'string' ? raw.projects : '',
    certifications: typeof raw?.certifications === 'string' ? raw.certifications : '',
    skills: typeof raw?.skills === 'string' ? raw.skills : '',
});
const cacheKey = (userId, templateSlug, contentHash) => `template:ai:fill:${userId}:${templateSlug}:${contentHash}`;
const hashUserProfile = (user) => {
    const p = user.profile ?? {};
    const rp = p.resumeProfile;
    const payload = JSON.stringify([
        p.fullName,
        p.headline,
        p.skills,
        p.resumeText?.slice(0, 1000),
        rp?.profileSummary,
        rp?.employments,
        rp?.educations,
        rp?.projects,
        rp?.accomplishments,
    ]);
    return crypto_1.default.createHash('sha1').update(payload).digest('hex').slice(0, 16);
};
const aiEnhanceTemplateContent = async (user, templateSlug) => {
    await (0, aiKeySync_service_1.syncAllProvidersToAppConfig)().catch((err) => {
        logger_1.logger.warn(`templateAiFiller: aiKey sync failed — falling back to AppConfig as-is: ${err.message}`);
    });
    if (!(0, providers_1.isAiEnabled)()) {
        logger_1.logger.info('templateAiFiller: AI disabled (no provider has a valid key in AppConfig/AiKey). Falling back to plain fill.');
        return null;
    }
    const userId = user._id.toString();
    const contentHash = hashUserProfile(user);
    const key = cacheKey(userId, templateSlug, contentHash);
    try {
        const cached = await redis_1.redis.get(key);
        if (cached) {
            (0, providers_1.recordCacheHit)({ userId, feature: FEATURE }, 'smart');
            return JSON.parse(cached);
        }
    }
    catch (e) {
        logger_1.logger.warn(`templateAiFiller cache read failed: ${e.message}`);
    }
    try {
        const parsed = await (0, providers_1.generateJson)({
            tier: 'smart',
            system: SYSTEM_PROMPT,
            user: buildUserPrompt(user),
            maxTokens: 1800,
            temperature: 0.3,
        }, { userId, feature: FEATURE });
        if (!parsed)
            return null;
        const clean = sanitize(parsed);
        try {
            await redis_1.redis.setex(key, CACHE_TTL_SEC, JSON.stringify(clean));
        }
        catch (e) {
            logger_1.logger.warn(`templateAiFiller cache write failed: ${e.message}`);
        }
        return clean;
    }
    catch (err) {
        logger_1.logger.warn(`templateAiFiller generate failed: ${err.message}`);
        return null;
    }
};
exports.aiEnhanceTemplateContent = aiEnhanceTemplateContent;
