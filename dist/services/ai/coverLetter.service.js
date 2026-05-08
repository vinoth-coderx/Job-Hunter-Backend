"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCoverLetter = void 0;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const env_1 = require("../../config/env");
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const client = env_1.env.ANTHROPIC_API_KEY
    ? new sdk_1.default({ apiKey: env_1.env.ANTHROPIC_API_KEY })
    : null;
const MODEL = 'claude-haiku-4-5-20251001';
const cacheKey = (userId, jobId, tone) => `coverletter:${userId}:${jobId}:${tone}`;
const profileBlock = (user) => {
    const p = user.profile;
    const lines = [
        `Name: ${p.fullName}`,
        p.headline ? `Headline: ${p.headline}` : null,
        `Experience: ${p.experienceYears} year${p.experienceYears === 1 ? '' : 's'}`,
        p.skills?.length ? `Skills: ${p.skills.slice(0, 20).join(', ')}` : null,
        p.preferredRoles?.length
            ? `Targeting: ${p.preferredRoles.slice(0, 4).join(', ')}`
            : null,
        p.preferredLocations?.length
            ? `Locations: ${p.preferredLocations.slice(0, 4).join(', ')}`
            : null,
    ].filter(Boolean);
    return lines.join('\n');
};
const jobBlock = (job) => {
    const lines = [
        `Job: ${job.title}`,
        `Company: ${job.company}`,
        `Location: ${job.location}`,
        `Type: ${job.jobType} · ${job.remoteType}`,
        job.skills?.length
            ? `Required skills: ${job.skills.slice(0, 12).join(', ')}`
            : null,
        job.experienceMinYears !== undefined || job.experienceMaxYears !== undefined
            ? `Experience expected: ${job.experienceMinYears ?? 0}–${job.experienceMaxYears ?? 'any'} yrs`
            : null,
        `\nJob description:\n${job.description.slice(0, 3000)}`,
    ].filter(Boolean);
    return lines.join('\n');
};
const TONE_GUIDANCE = {
    professional: 'Polished and formal. Lead with impact, keep paragraphs tight. No emoji or slang.',
    friendly: 'Warm and approachable. Conversational while still concise. Sound like a real person, not a template.',
    technical: 'Specific and concrete. Highlight relevant tech stack overlaps and quantifiable wins. No fluff.',
};
const fallback = (user, job) => `Hi ${job.company} team,

I'm ${user.profile.fullName}${user.profile.headline ? `, a ${user.profile.headline.toLowerCase()}` : ''}, and I'd like to be considered for the ${job.title} role.

${user.profile.experienceYears > 0 ? `With ${user.profile.experienceYears} year${user.profile.experienceYears === 1 ? '' : 's'} of experience` : 'Bringing fresh energy and a strong drive to learn'} ${user.profile.skills?.length ? `working with ${user.profile.skills.slice(0, 4).join(', ')}` : ''}, I'm excited about what your team is building and believe my background lines up well with what you're looking for.

I'd love the chance to discuss how I can contribute. Thanks for considering my application.

— ${user.profile.fullName}`.trim();
const generateCoverLetter = async (params) => {
    const tone = params.tone ?? 'professional';
    const key = cacheKey(params.user._id.toString(), params.job._id.toString(), tone);
    const cached = await redis_1.redis.get(key);
    if (cached)
        return { letter: cached, usedAi: true };
    if (!client) {
        return { letter: fallback(params.user, params.job), usedAi: false };
    }
    const system = `You write concise, sincere cover letters for job applications. Constraints:
- Output ONLY the letter body (no subject line, no contact block, no metadata).
- 130–200 words.
- 3 short paragraphs max.
- Open with a specific hook tied to THIS company or role, not a generic intro.
- One paragraph on relevant experience/skills. Reference 2–3 specifics from the job description.
- One closing paragraph with a clear interest + thanks. No "looking forward to hearing back" templates.
- Never invent achievements, certifications, employers, or projects not in the candidate profile.
- Tone: ${TONE_GUIDANCE[tone]}`;
    const user = `Candidate profile:
${profileBlock(params.user)}

${params.baseTemplate ? `User-supplied base template (treat as guidance, do not copy verbatim):\n${params.baseTemplate.slice(0, 2000)}\n\n` : ''}${jobBlock(params.job)}

Write the cover letter now.`;
    try {
        const res = await client.messages.create({
            model: MODEL,
            max_tokens: 600,
            system,
            messages: [{ role: 'user', content: user }],
        });
        const block = res.content[0];
        const text = block && block.type === 'text' && typeof block.text === 'string'
            ? block.text.trim()
            : '';
        if (!text) {
            return { letter: fallback(params.user, params.job), usedAi: false };
        }
        await redis_1.redis.setex(key, 60 * 60 * 24 * 7, text);
        return { letter: text, usedAi: true };
    }
    catch (err) {
        logger_1.logger.warn(`coverLetter failed: ${err.message}`);
        return { letter: fallback(params.user, params.job), usedAi: false };
    }
};
exports.generateCoverLetter = generateCoverLetter;
