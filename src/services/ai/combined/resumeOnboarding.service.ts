import { logger } from '../../../utils/logger';
import { IJob } from '../../../models/Job';
import { generateJson } from '../providers';
import { ParsedResume, sanitizeParsedResume } from '../resumeParser.service';

/**
 * One-shot resume onboarding pipeline.
 *
 * In a single Gemini "smart" call, this returns:
 *   1. parsed structured resume (same shape as resumeParser)
 *   2. top-N matches from a candidate job pool, scored 0-100 with reasoning
 *   3. concrete improvement suggestions to raise future match scores
 *   4. a one-line career insight ("you're a backend dev pivoting to ML…")
 *
 * Combining these into one prompt instead of N separate calls is the core
 * free-tier optimization — each call counts as one quota slot, and we
 * already pay the context cost for the resume + jobs once.
 */

export interface MatchSummary {
  jobId: string;
  title: string;
  company: string;
  score: number; // 0-100
  reasoning: string;
  matchedSkills: string[];
  missingSkills: string[];
}

export interface ResumeImprovement {
  area: 'skills' | 'experience' | 'summary' | 'projects' | 'keywords' | 'formatting';
  suggestion: string;
  // Why this raises match scores — gives the user a reason to act.
  impact: string;
}

export interface ResumeOnboardingResult {
  parsedResume: ParsedResume;
  topMatches: MatchSummary[];
  improvements: ResumeImprovement[];
  careerInsight: string;
}

const MAX_RESUME_CHARS = 15000;
const MAX_JOB_CANDIDATES = 30;
const MAX_JOB_DESC_CHARS = 800;

const compactJob = (j: IJob): string => {
  const desc = (j.description || '').replace(/\s+/g, ' ').slice(0, MAX_JOB_DESC_CHARS);
  return [
    `id:${j._id.toString()}`,
    `title:${j.title}`,
    `co:${j.company}`,
    `loc:${j.location}|${j.remoteType}`,
    `type:${j.jobType}`,
    `exp:${j.experienceMinYears ?? '?'}-${j.experienceMaxYears ?? '?'}y`,
    `skills:${(j.skills || []).slice(0, 12).join(',')}`,
    `desc:${desc}`,
  ].join(' | ');
};

const SYSTEM_PROMPT = `You are an end-to-end career assistant. From a candidate's raw resume text and a list of available jobs, you produce a single JSON object with four fields. You never invent skills the candidate doesn't have. You never recommend a job the candidate is unqualified for. Output STRICT JSON, no prose.

Schema (return EXACTLY this shape):
{
  "parsedResume": {
    "headline": "1-line professional headline (role + 2-3 specialties)",
    "summary": "Profile summary paragraph (verbatim or synthesised)",
    "skills": ["array of distinct skills, max 30, candidate's exact wording"],
    "experienceYears": <integer 0-50>,
    "location": "City, Country",
    "phone": "phone with country code or empty",
    "employments": [{"designation":"","company":"","period":"","current":false}],
    "educations": [{"degree":"","institute":"","period":"","type":"Full Time|Part Time|Distance Learning"}],
    "itSkills": [{"skill":"","lastUsed":"YYYY","experience":"X Years Y Months"}],
    "projects": [{"title":"","company":"","type":"","period":"","description":""}],
    "languages": [{"language":"","proficiency":"Beginner|Intermediate|Proficient|Expert"}],
    "personalDetails": {"dob":"","address":"","gender":"","maritalStatus":"","category":"","workPermit":""},
    "careerProfile": {"currentIndustry":"","department":"","roleCategory":"","jobRole":"","desiredJobType":"","desiredEmploymentType":"","preferredShift":"","preferredLocation":"","expectedSalary":""},
    "accomplishments": [{"type":"Online profile|Work sample|White paper / Research publication / Journal entry|Presentation|Patent|Certification","label":"","value":""}]
  },
  "topMatches": [
    {
      "jobId": "<exact id from input>",
      "title": "<job title>",
      "company": "<company>",
      "score": <0-100>,
      "reasoning": "<one short sentence on why this fits>",
      "matchedSkills": ["candidate skills that align"],
      "missingSkills": ["job skills candidate lacks, max 5"]
    }
  ],
  "improvements": [
    {
      "area": "skills|experience|summary|projects|keywords|formatting",
      "suggestion": "<one specific actionable change>",
      "impact": "<why this raises match scores>"
    }
  ],
  "careerInsight": "<one sentence describing the candidate's trajectory or sweet spot>"
}

Rules:
- Return up to 5 topMatches with score >= 50, sorted descending. If nothing reaches 50, return the best available (still scored honestly).
- jobId in topMatches MUST be one of the ids passed in. Do NOT invent.
- Return 3-5 improvements, focused on changes that would unlock more/better matches in the given job pool.
- itSkills only programming languages, frameworks, libraries, databases, dev tools.
- careerProfile fields MAY be sensibly inferred from latest employment + skills (industry from latest company, role category from latest title, etc.). This is the ONLY inference allowed — everything else must be evidence-based.
- accomplishments.type MUST be one of: 'Online profile' (LinkedIn/Twitter/portfolio URLs), 'Work sample' (GitHub/Behance/Dribbble), 'Presentation' (talks/slide decks), 'White paper / Research publication / Journal entry' (papers), 'Patent' (granted/filed), 'Certification' (AWS, Coursera, etc.). Anything that doesn't fit — skip.
- personalDetails.category only if explicit ('General | OBC | SC | ST | EWS | Other'); personalDetails.workPermit only if explicit (e.g. 'Authorized to work in US', 'H1B', 'EU citizen').
- Empty fields when info missing — never invent.`;

export const runResumeOnboarding = async (
  resumeText: string,
  jobs: IJob[],
): Promise<ResumeOnboardingResult | null> => {
  const text = (resumeText || '').trim().slice(0, MAX_RESUME_CHARS);
  if (text.length < 50) {
    logger.info('runResumeOnboarding: resume text too short, skipping');
    return null;
  }

  const candidatePool = jobs.slice(0, MAX_JOB_CANDIDATES).map(compactJob).join('\n');

  const userPrompt = `RESUME:
${text}

AVAILABLE JOBS (${jobs.length} considered):
${candidatePool}

Return the JSON now.`;

  const result = await generateJson<ResumeOnboardingResult>({
    tier: 'smart',
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 6000,
    temperature: 0.3,
  });

  if (!result) return null;
  return sanitize(result, jobs);
};

const validJobIds = (jobs: IJob[]): Set<string> =>
  new Set(jobs.map((j) => j._id.toString()));

const asString = (v: unknown, max = 400): string =>
  (typeof v === 'string' ? v : '').trim().slice(0, max);

const asInt = (v: unknown, min = 0, max = 100): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(min, Math.min(max, n));
};

const sanitize = (raw: ResumeOnboardingResult, jobs: IJob[]): ResumeOnboardingResult => {
  const ids = validJobIds(jobs);
  const matchesIn = Array.isArray(raw.topMatches) ? raw.topMatches : [];
  const topMatches = matchesIn
    .filter((m): m is MatchSummary => !!m && typeof m === 'object')
    .filter((m) => ids.has(asString(m.jobId, 30)))
    .map((m) => ({
      jobId: asString(m.jobId, 30),
      title: asString(m.title, 200),
      company: asString(m.company, 200),
      score: asInt(m.score, 0, 100),
      reasoning: asString(m.reasoning, 300),
      matchedSkills: Array.isArray(m.matchedSkills)
        ? m.matchedSkills.map((s) => asString(s, 60)).filter(Boolean).slice(0, 10)
        : [],
      missingSkills: Array.isArray(m.missingSkills)
        ? m.missingSkills.map((s) => asString(s, 60)).filter(Boolean).slice(0, 5)
        : [],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const improvementsIn = Array.isArray(raw.improvements) ? raw.improvements : [];
  const validAreas = ['skills', 'experience', 'summary', 'projects', 'keywords', 'formatting'];
  const improvements = improvementsIn
    .filter((i): i is ResumeImprovement => !!i && typeof i === 'object')
    .map((i) => {
      const area = asString(i.area, 30);
      return {
        area: (validAreas.includes(area) ? area : 'skills') as ResumeImprovement['area'],
        suggestion: asString(i.suggestion, 400),
        impact: asString(i.impact, 300),
      };
    })
    .filter((i) => i.suggestion.length > 0)
    .slice(0, 5);

  return {
    parsedResume: sanitizeParsedResume(raw.parsedResume),
    topMatches,
    improvements,
    careerInsight: asString(raw.careerInsight, 400),
  };
};
