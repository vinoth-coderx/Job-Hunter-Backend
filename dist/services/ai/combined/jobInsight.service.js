"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runJobInsight = void 0;
const logger_1 = require("../../../utils/logger");
const providers_1 = require("../providers");
const compactProfile = (user) => [
    `Name: ${user.profile.fullName}`,
    `Headline: ${user.profile.headline || 'N/A'}`,
    `Experience: ${user.profile.experienceYears ?? 0} years`,
    `Skills: ${(user.profile.skills || []).slice(0, 30).join(', ') || 'N/A'}`,
    `Preferred Roles: ${(user.profile.preferredRoles || []).join(', ') || 'N/A'}`,
    `Resume Excerpt: ${(user.profile.resumeText || '').slice(0, 1500)}`,
].join('\n');
const compactJob = (job) => [
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location} (${job.remoteType})`,
    `Type: ${job.jobType}`,
    `Experience: ${job.experienceMinYears ?? '?'}-${job.experienceMaxYears ?? '?'} years`,
    `Required Skills: ${(job.skills || []).join(', ')}`,
    `Description: ${(job.description || '').slice(0, 1800)}`,
].join('\n');
const SYSTEM_PROMPT = `You are a career assistant producing one consolidated insight for a candidate viewing a single job. Output STRICT JSON, no prose, no markdown fences.

Schema:
{
  "matchScore": {
    "score": <0-100>,
    "reasoning": "<one sentence on why this score>",
    "matchedSkills": ["candidate skills aligned with the job"],
    "missingSkills": ["job skills candidate lacks, max 5"]
  },
  "coverLetter": {
    "opening": "<2-3 sentence personalised opener referencing the company and role>",
    "body": "<3-5 sentence body highlighting fit, top 2 relevant achievements, and intent>"
  },
  "skillGap": {
    "missing": [
      { "skill": "<name>", "priority": "high|medium|low", "rampUp": "<one short ramp-up suggestion>" }
    ],
    "summary": "<one sentence summary of the gap>"
  },
  "interviewPrep": [
    { "question": "<likely first-round question>", "whyAsked": "<one short reason this would be asked>" }
  ]
}

Rules:
- coverLetter must be specific to THIS company and role — never generic boilerplate.
- coverLetter must NOT invent achievements; only reference what's in the resume.
- interviewPrep returns exactly 3 items.
- skillGap.missing returns at most 5 items, ordered by priority desc.
- Tone: professional, confident, no hype words ("synergy", "rockstar", etc.).`;
const runJobInsight = async (user, job) => {
    const userPrompt = `CANDIDATE PROFILE:
${compactProfile(user)}

JOB:
${compactJob(job)}

Return the JSON now.`;
    try {
        const result = await (0, providers_1.generateJson)({
            tier: 'smart',
            system: SYSTEM_PROMPT,
            user: userPrompt,
            maxTokens: 2500,
            temperature: 0.4,
        });
        if (!result)
            return null;
        return sanitize(result);
    }
    catch (err) {
        logger_1.logger.warn(`runJobInsight failed: ${err.message}`);
        throw err;
    }
};
exports.runJobInsight = runJobInsight;
const asString = (v, max = 400) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const asInt = (v, min, max) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
    return Math.max(min, Math.min(max, n));
};
const validPriority = (v) => {
    const s = asString(v, 10).toLowerCase();
    if (s === 'high' || s === 'medium' || s === 'low')
        return s;
    return 'medium';
};
const sanitize = (raw) => {
    const ms = raw.matchScore || {};
    const cl = raw.coverLetter || {};
    const sg = raw.skillGap || {};
    const ipIn = Array.isArray(raw.interviewPrep) ? raw.interviewPrep : [];
    const missingIn = Array.isArray(sg.missing) ? sg.missing : [];
    return {
        matchScore: {
            score: asInt(ms.score, 0, 100),
            reasoning: asString(ms.reasoning, 300),
            matchedSkills: Array.isArray(ms.matchedSkills)
                ? ms.matchedSkills.map((s) => asString(s, 60)).filter(Boolean).slice(0, 10)
                : [],
            missingSkills: Array.isArray(ms.missingSkills)
                ? ms.missingSkills.map((s) => asString(s, 60)).filter(Boolean).slice(0, 5)
                : [],
        },
        coverLetter: {
            opening: asString(cl.opening, 600),
            body: asString(cl.body, 2000),
        },
        skillGap: {
            missing: missingIn
                .filter((m) => !!m && typeof m === 'object')
                .map((m) => ({
                skill: asString(m.skill, 60),
                priority: validPriority(m.priority),
                rampUp: asString(m.rampUp, 200),
            }))
                .filter((m) => m.skill.length > 0)
                .slice(0, 5),
            summary: asString(sg.summary, 300),
        },
        interviewPrep: ipIn
            .filter((q) => !!q && typeof q === 'object')
            .map((q) => ({
            question: asString(q.question, 300),
            whyAsked: asString(q.whyAsked, 200),
        }))
            .filter((q) => q.question.length > 0)
            .slice(0, 3),
    };
};
