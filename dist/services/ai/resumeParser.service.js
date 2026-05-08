"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseResumeText = void 0;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const env_1 = require("../../config/env");
const logger_1 = require("../../utils/logger");
const client = env_1.env.ANTHROPIC_API_KEY
    ? new sdk_1.default({ apiKey: env_1.env.ANTHROPIC_API_KEY })
    : null;
const MODEL = 'claude-haiku-4-5-20251001';
const empty = {
    headline: '',
    summary: '',
    skills: [],
    experienceYears: 0,
    location: '',
    phone: '',
    employments: [],
    educations: [],
    itSkills: [],
    projects: [],
    languages: [],
    personalDetails: { dob: '', address: '', gender: '', maritalStatus: '' },
    usedAi: false,
};
const asString = (v, max = 400) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const asStringArray = (v, max = 30, itemMax = 80) => {
    if (!Array.isArray(v))
        return [];
    return v
        .map((x) => asString(x, itemMax))
        .filter((s) => s.length > 0)
        .slice(0, max);
};
const sanitize = (raw) => {
    if (!raw || typeof raw !== 'object')
        return empty;
    const r = raw;
    const personal = (r.personalDetails ?? {});
    const yearsRaw = r.experienceYears;
    const years = typeof yearsRaw === 'number' && Number.isFinite(yearsRaw)
        ? Math.max(0, Math.min(50, Math.round(yearsRaw)))
        : 0;
    const employmentsArr = Array.isArray(r.employments) ? r.employments : [];
    const educationsArr = Array.isArray(r.educations) ? r.educations : [];
    const itSkillsArr = Array.isArray(r.itSkills) ? r.itSkills : [];
    const projectsArr = Array.isArray(r.projects) ? r.projects : [];
    const languagesArr = Array.isArray(r.languages) ? r.languages : [];
    const validProficiency = (v) => {
        const s = asString(v);
        if (s === 'Beginner' || s === 'Intermediate' || s === 'Proficient' || s === 'Expert')
            return s;
        return 'Intermediate';
    };
    return {
        usedAi: true,
        headline: asString(r.headline, 200),
        summary: asString(r.summary, 1500),
        skills: asStringArray(r.skills, 30, 60),
        experienceYears: years,
        location: asString(r.location, 120),
        phone: asString(r.phone, 30),
        employments: employmentsArr
            .filter((x) => typeof x === 'object' && x !== null)
            .slice(0, 15)
            .map((e) => ({
            designation: asString(e.designation, 100),
            company: asString(e.company, 100),
            period: asString(e.period, 60),
            current: e.current === true,
        }))
            .filter((e) => e.designation.length > 0 || e.company.length > 0),
        educations: educationsArr
            .filter((x) => typeof x === 'object' && x !== null)
            .slice(0, 10)
            .map((e) => ({
            degree: asString(e.degree, 150),
            institute: asString(e.institute, 200),
            period: asString(e.period, 60),
            type: asString(e.type, 40) || 'Full Time',
        }))
            .filter((e) => e.degree.length > 0 || e.institute.length > 0),
        itSkills: itSkillsArr
            .filter((x) => typeof x === 'object' && x !== null)
            .slice(0, 25)
            .map((s) => ({
            skill: asString(s.skill, 60),
            lastUsed: asString(s.lastUsed, 20),
            experience: asString(s.experience, 40),
        }))
            .filter((s) => s.skill.length > 0),
        projects: projectsArr
            .filter((x) => typeof x === 'object' && x !== null)
            .slice(0, 10)
            .map((p) => ({
            title: asString(p.title, 150),
            company: asString(p.company, 100),
            type: asString(p.type, 40) || 'Full Time',
            period: asString(p.period, 60),
            description: asString(p.description, 1000),
        }))
            .filter((p) => p.title.length > 0),
        languages: languagesArr
            .filter((x) => typeof x === 'object' && x !== null)
            .slice(0, 10)
            .map((l) => ({
            language: asString(l.language, 40),
            proficiency: validProficiency(l.proficiency),
        }))
            .filter((l) => l.language.length > 0),
        personalDetails: {
            dob: asString(personal.dob, 30),
            address: asString(personal.address, 300),
            gender: asString(personal.gender, 20),
            maritalStatus: asString(personal.maritalStatus, 30),
        },
    };
};
const SYSTEM_PROMPT = `You extract structured data from resume text. Output ONLY strict JSON — no prose, no markdown fences. Schema:

{
  "headline": "1-line professional headline (role + 2-3 specialties)",
  "summary": "Profile summary paragraph from the resume (verbatim if present, otherwise synthesised from the resume's content)",
  "skills": ["array of distinct skill keywords, max 30, prefer the candidate's exact wording"],
  "experienceYears": number (total years of professional experience, integer 0-50),
  "location": "City, Country (current location of candidate)",
  "phone": "phone number with country code if present, else empty",
  "employments": [
    { "designation": "job title", "company": "company name", "period": "Mon YYYY - Mon YYYY or Present", "current": true if current job }
  ],
  "educations": [
    { "degree": "full degree name", "institute": "institute name", "period": "YYYY-YYYY", "type": "Full Time | Part Time | Distance Learning" }
  ],
  "itSkills": [
    { "skill": "technology name", "lastUsed": "YYYY", "experience": "X Years Y Months" }
  ],
  "projects": [
    { "title": "project name", "company": "associated company or 'Personal'", "type": "Full Time | Part Time | Personal", "period": "Mon YYYY to Mon YYYY", "description": "what the project does" }
  ],
  "languages": [
    { "language": "language name", "proficiency": "Beginner | Intermediate | Proficient | Expert" }
  ],
  "personalDetails": {
    "dob": "DD Mon YYYY if present, else empty",
    "address": "full address if present, else empty",
    "gender": "Male | Female | Other if explicit, else empty",
    "maritalStatus": "Single | Married if explicit, else empty"
  }
}

Rules:
- Output ONLY the JSON object, nothing else.
- For any field where the resume gives no information, return an empty string, 0, or empty array — NEVER invent.
- Do not hallucinate skills the candidate didn't list.
- Use the candidate's own wording where possible.
- itSkills should only include programming languages, frameworks, libraries, databases, dev tools — not general "skills" like "communication".
- skills can include both technical and soft skills, taken verbatim from the resume.
- If the resume is empty or not actually a resume, return all fields empty.`;
const parseResumeText = async (resumeText) => {
    const text = (resumeText || '').trim();
    if (text.length < 50)
        return empty;
    if (!client) {
        logger_1.logger.info('resumeParser: ANTHROPIC_API_KEY not configured, returning empty');
        return empty;
    }
    const input = text.slice(0, 18000);
    try {
        const res = await client.messages.create({
            model: MODEL,
            max_tokens: 4000,
            system: SYSTEM_PROMPT,
            messages: [
                {
                    role: 'user',
                    content: `Resume text:\n\n${input}\n\nReturn the JSON now.`,
                },
            ],
        });
        const block = res.content[0];
        const raw = block && block.type === 'text' && typeof block.text === 'string' ? block.text.trim() : '';
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const parsed = JSON.parse(cleaned);
        return sanitize(parsed);
    }
    catch (err) {
        logger_1.logger.warn(`resumeParser failed: ${err.message}`);
        return empty;
    }
};
exports.parseResumeText = parseResumeText;
