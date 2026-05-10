import { logger } from '../../utils/logger';
import { generateJson } from './providers';

/**
 * JD generator for hirers. Single Gemini "smart" call, structured JSON.
 *
 * Hirer types role + 2-3 keywords + company name + experience band; we
 * return a full JD draft they can edit before posting. One quota slot.
 */

export interface GenerateJdInput {
  role: string;
  companyName: string;
  experienceMinYears?: number;
  experienceMaxYears?: number;
  location?: string;
  remoteType?: 'onsite' | 'hybrid' | 'remote';
  jobType?: string;
  keywords?: string[];
  toneHint?: 'professional' | 'casual' | 'startup';
}

export interface GeneratedJd {
  title: string;
  description: string;
  responsibilities: string[];
  requiredSkills: string[];
  niceToHaveSkills: string[];
  perks: string[];
  screeningQuestions: Array<{ question: string; type: 'text' | 'yes_no' | 'numeric' }>;
}

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

const asString = (v: unknown, max = 400): string =>
  (typeof v === 'string' ? v : '').trim().slice(0, max);

const asStringArray = (v: unknown, maxItems: number, itemMax = 200): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => asString(x, itemMax))
    .filter((s) => s.length > 0)
    .slice(0, maxItems);
};

const validQuestionType = (v: unknown): 'text' | 'yes_no' | 'numeric' => {
  const s = asString(v, 20);
  if (s === 'yes_no' || s === 'numeric') return s;
  return 'text';
};

const sanitize = (raw: GeneratedJd): GeneratedJd => {
  const sqIn: unknown[] = Array.isArray(raw.screeningQuestions) ? raw.screeningQuestions : [];
  return {
    title: asString(raw.title, 200),
    description: asString(raw.description, 8000),
    responsibilities: asStringArray(raw.responsibilities, 12, 300),
    requiredSkills: asStringArray(raw.requiredSkills, 15, 60),
    niceToHaveSkills: asStringArray(raw.niceToHaveSkills, 10, 60),
    perks: asStringArray(raw.perks, 10, 100),
    screeningQuestions: sqIn
      .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
      .map((q) => ({
        question: asString(q.question, 300),
        type: validQuestionType(q.type),
      }))
      .filter((q) => q.question.length > 0)
      .slice(0, 5),
  };
};

export const generateJd = async (input: GenerateJdInput): Promise<GeneratedJd | null> => {
  const role = (input.role || '').trim();
  const company = (input.companyName || '').trim();
  if (role.length < 2 || company.length < 2) {
    logger.info('generateJd: role or company too short, skipping');
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

  const result = await generateJson<GeneratedJd>({
    tier: 'smart',
    system: SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: 3000,
    temperature: 0.5,
  });

  if (!result) return null;
  return sanitize(result);
};
