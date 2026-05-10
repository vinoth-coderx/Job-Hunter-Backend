import { logger } from '../../utils/logger';
import { IUser } from '../../models/User';
import { generate, generateJson, isAiEnabled } from './providers';

/**
 * Per-field value generator for the Profile Coach.
 *
 * When the optimizer surfaces a suggestion like "Add a clear headline" but
 * doesn't bundle a concrete `suggestedValue`, the user taps "Generate" →
 * we call this service for that ONE field. Returns either a string or a
 * string list (depending on field shape) the client can pipe into
 * AuthProvider.updateProfile.
 *
 * One quota slot per call, enforced at the controller layer.
 */

export type SuggestableField =
  | 'headline'
  | 'summary'
  | 'skills'
  | 'preferredRoles'
  | 'preferredLocations'
  | 'preferredJobTypes'
  | 'experienceYears'
  | 'expectedSalary';

export interface FieldSuggestion {
  field: SuggestableField;
  // String value for free-text fields (headline, summary, salary).
  value?: string;
  // Array value for chip-list fields (skills, roles, locations, jobTypes).
  values?: string[];
  // Numeric value for numeric fields (experienceYears, expectedSalary).
  numericValue?: number;
}

const profileBlock = (user: IUser): string => {
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

export const suggestField = async (
  user: IUser,
  field: SuggestableField,
): Promise<FieldSuggestion | null> => {
  if (!isAiEnabled()) return null;

  const ctx = profileBlock(user);

  switch (field) {
    case 'headline': {
      const text = await generate({
        tier: 'lite',
        system:
          'You write 1-line professional headlines for job seekers. Output ONLY the headline text, no quotes, no preamble, 60-110 chars. Format: "<seniority> <role> · <2-3 specialties>".',
        user: `Candidate profile:\n${ctx}\n\nWrite the headline.`,
        maxTokens: 100,
        temperature: 0.6,
      });
      const v = sanitizeText(text.text, 200);
      return v ? { field, value: v } : null;
    }

    case 'summary': {
      const text = await generate({
        tier: 'lite',
        system:
          'You write 2-4 sentence profile summaries for job seekers. Plain prose, third-person, no bullets, no quotes. Highlight specialties + 1-2 strengths grounded in the profile. Never invent skills.',
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
      const parsed = await generateJson<{ values?: unknown }>({
        tier: 'lite',
        system: listSystemPrompt(field),
        user: `Candidate profile:\n${ctx}\n\nReturn the JSON now.`,
        maxTokens: 400,
        temperature: 0.5,
      });
      if (!parsed) return null;
      let arr = Array.isArray(parsed.values) ? parsed.values : [];
      let cleaned = arr
        .map((x) => sanitizeText(String(x), 60))
        .filter((s): s is string => !!s && s.length > 0);

      if (field === 'preferredJobTypes') {
        cleaned = cleaned
          .map((s) => s.toLowerCase().trim())
          .filter((s) => VALID_JOB_TYPES.includes(s));
      }

      // Drop values the user already has so the suggestion reads as
      // "additions" not duplicates.
      const existing = new Set(
        (((user.profile as unknown as Record<string, unknown>)[field]) as string[] | undefined) ?? [],
      );
      cleaned = cleaned.filter((s) => !Array.from(existing).map((e) => e.toLowerCase()).includes(s.toLowerCase()));

      const cap = field === 'skills' ? 10 : 5;
      cleaned = cleaned.slice(0, cap);
      return cleaned.length > 0 ? { field, values: cleaned } : null;
    }

    case 'experienceYears': {
      const parsed = await generateJson<{ years?: unknown }>({
        tier: 'lite',
        system:
          'From a candidate profile, infer their TOTAL professional years of experience. Output strict JSON: {"years": <integer 0-50>}. If unclear, use the resume excerpt or default to 1.',
        user: `Candidate profile:\n${ctx}\n\nReturn the JSON now.`,
        maxTokens: 60,
        temperature: 0.2,
      });
      const n = typeof parsed?.years === 'number' ? Math.round(parsed.years) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 50) return null;
      return { field, numericValue: n };
    }

    case 'expectedSalary': {
      const parsed = await generateJson<{ inrPerYear?: unknown }>({
        tier: 'lite',
        system:
          'You suggest a sensible MINIMUM expected annual salary in INR for a candidate based on their experience, skills, and target role. Output strict JSON: {"inrPerYear": <integer>}. Use Indian market rates. Round to nearest 50,000.',
        user: `Candidate profile:\n${ctx}\n\nReturn the JSON now.`,
        maxTokens: 80,
        temperature: 0.3,
      });
      const n =
        typeof parsed?.inrPerYear === 'number' ? Math.round(parsed.inrPerYear) : NaN;
      if (!Number.isFinite(n) || n <= 0 || n > 50_000_000) return null;
      return { field, numericValue: n };
    }

    default:
      logger.warn(`suggestField: unsupported field ${field}`);
      return null;
  }
};

const sanitizeText = (s: string, max: number): string => {
  const t = (s || '').trim().replace(/^["']|["']$/g, '');
  return t.slice(0, max);
};

const listSystemPrompt = (
  field: 'skills' | 'preferredRoles' | 'preferredLocations' | 'preferredJobTypes',
): string => {
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
