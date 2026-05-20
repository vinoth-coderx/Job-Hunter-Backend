"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseResumeText = exports.sanitizeParsedResume = void 0;
const logger_1 = require("../../utils/logger");
const providers_1 = require("./providers");
const emptyCareer = {
    currentIndustry: '',
    department: '',
    roleCategory: '',
    jobRole: '',
    desiredJobType: '',
    desiredEmploymentType: '',
    preferredShift: '',
    preferredLocation: '',
    expectedSalary: '',
};
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
    personalDetails: {
        dob: '',
        address: '',
        gender: '',
        maritalStatus: '',
        category: '',
        workPermit: '',
    },
    careerProfile: emptyCareer,
    accomplishments: [],
    usedAi: false,
};
const ACCOMPLISHMENT_TYPES = [
    'Online profile',
    'Work sample',
    'White paper / Research publication / Journal entry',
    'Presentation',
    'Patent',
    'Certification',
];
const asString = (v, max = 400) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const asStringArray = (v, max = 30, itemMax = 80) => {
    if (!Array.isArray(v))
        return [];
    return v
        .map((x) => asString(x, itemMax))
        .filter((s) => s.length > 0)
        .slice(0, max);
};
const validAccomplishmentType = (v) => {
    const s = asString(v);
    return ACCOMPLISHMENT_TYPES.includes(s)
        ? s
        : null;
};
const sanitizeParsedResume = (raw) => {
    if (!raw || typeof raw !== 'object')
        return empty;
    const r = raw;
    const personal = (r.personalDetails ?? {});
    const career = (r.careerProfile ?? {});
    const yearsRaw = r.experienceYears;
    const years = typeof yearsRaw === 'number' && Number.isFinite(yearsRaw)
        ? Math.max(0, Math.min(50, Math.round(yearsRaw)))
        : 0;
    const employmentsArr = Array.isArray(r.employments) ? r.employments : [];
    const educationsArr = Array.isArray(r.educations) ? r.educations : [];
    const itSkillsArr = Array.isArray(r.itSkills) ? r.itSkills : [];
    const projectsArr = Array.isArray(r.projects) ? r.projects : [];
    const languagesArr = Array.isArray(r.languages) ? r.languages : [];
    const accomplishmentsArr = Array.isArray(r.accomplishments)
        ? r.accomplishments
        : [];
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
            category: asString(personal.category, 60),
            workPermit: asString(personal.workPermit, 120),
        },
        careerProfile: {
            currentIndustry: asString(career.currentIndustry, 100),
            department: asString(career.department, 100),
            roleCategory: asString(career.roleCategory, 100),
            jobRole: asString(career.jobRole, 100),
            desiredJobType: asString(career.desiredJobType, 60),
            desiredEmploymentType: asString(career.desiredEmploymentType, 60),
            preferredShift: asString(career.preferredShift, 60),
            preferredLocation: asString(career.preferredLocation, 200),
            expectedSalary: asString(career.expectedSalary, 60),
        },
        accomplishments: accomplishmentsArr
            .filter((x) => typeof x === 'object' && x !== null)
            .map((a) => {
            const type = validAccomplishmentType(a.type);
            if (!type)
                return null;
            const value = asString(a.value, 400);
            if (value.length === 0)
                return null;
            return {
                type,
                label: asString(a.label, 200) || type,
                value,
            };
        })
            .filter((x) => x !== null)
            .slice(0, 20),
    };
};
exports.sanitizeParsedResume = sanitizeParsedResume;
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
    "maritalStatus": "Single | Married if explicit, else empty",
    "category": "General | OBC | SC | ST | EWS | Other only if the resume explicitly states it, else empty",
    "workPermit": "country names where the candidate has the right to work, comma-separated; only if explicit (e.g. 'Authorized to work in US', 'H1B visa', 'EU citizen'), else empty"
  },
  "careerProfile": {
    "currentIndustry": "industry of most recent employer (e.g. 'IT Services & Consulting', 'Banking / Financial Services', 'E-commerce'); infer from latest company if not stated",
    "department": "functional department (e.g. 'Engineering - Software & QA', 'Sales & Business Development', 'Marketing'); infer from latest role",
    "roleCategory": "role family (e.g. 'Software Development', 'DevOps', 'Product Management', 'Data Science'); infer from latest title + skills",
    "jobRole": "specific job title from most recent role (e.g. 'Senior Software Engineer', 'Full Stack Developer')",
    "desiredJobType": "Permanent | Contractual | Internship | Freelance — infer 'Permanent' if working full-time, else empty",
    "desiredEmploymentType": "Full Time | Part Time — infer from current role pattern",
    "preferredShift": "Day | Night | Flexible — only if explicit, else empty",
    "preferredLocation": "preferred work cities/countries if stated, else current location",
    "expectedSalary": "exact stated expected salary with currency if present, else empty"
  },
  "accomplishments": [
    {
      "type": "one of: 'Online profile' | 'Work sample' | 'White paper / Research publication / Journal entry' | 'Presentation' | 'Patent' | 'Certification'",
      "label": "short readable label (e.g. 'LinkedIn', 'GitHub', 'AWS Solutions Architect')",
      "value": "the URL, certificate name + issuer + year, patent number, or publication title — whatever identifies the item"
    }
  ]
}

Rules:
- Output ONLY the JSON object, nothing else.
- For any field where the resume gives no information, return an empty string, 0, or empty array — NEVER invent.
- Do not hallucinate skills the candidate didn't list.
- Use the candidate's own wording where possible.
- itSkills should only include programming languages, frameworks, libraries, databases, dev tools — not general "skills" like "communication".
- skills can include both technical and soft skills, taken verbatim from the resume.
- careerProfile fields MAY be sensibly inferred from latest employment + skills (e.g. industry from latest company, role category from latest title). This is the ONLY place inference is allowed — everything else must be evidence-based.
- accomplishments.type MUST be one of the exact strings listed above; anything that doesn't fit those buckets — skip it.
- For accomplishments: LinkedIn/Twitter/portfolio URLs → 'Online profile'; GitHub/Behance/Dribbble → 'Work sample'; conference talks/slide decks → 'Presentation'; papers/journals → 'White paper / Research publication / Journal entry'; certifications (AWS, Google, Coursera certificates) → 'Certification'; granted/filed patents → 'Patent'.
- If the resume is empty or not actually a resume, return all fields empty.`;
const parseResumeText = async (resumeText) => {
    const text = (resumeText || '').trim();
    if (text.length < 50)
        return empty;
    if (!(0, providers_1.isAiEnabled)()) {
        logger_1.logger.info('resumeParser: no AI provider configured, returning empty');
        return empty;
    }
    const input = text.slice(0, 18000);
    try {
        const parsed = await (0, providers_1.generateJson)({
            tier: 'lite',
            system: SYSTEM_PROMPT,
            user: `Resume text:\n\n${input}\n\nReturn the JSON now.`,
            maxTokens: 4000,
            temperature: 0.2,
        });
        if (!parsed)
            return empty;
        return (0, exports.sanitizeParsedResume)(parsed);
    }
    catch (err) {
        logger_1.logger.warn(`resumeParser failed: ${err.message}`);
        return empty;
    }
};
exports.parseResumeText = parseResumeText;
