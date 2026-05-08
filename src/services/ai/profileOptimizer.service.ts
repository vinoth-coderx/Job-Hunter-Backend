import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { IUser } from '../../models/User';
import { redis } from '../../config/redis';

const client = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

const MODEL = 'claude-haiku-4-5-20251001';

export type SuggestionPriority = 'high' | 'medium' | 'low';
export type SuggestionField =
  | 'headline'
  | 'skills'
  | 'experience'
  | 'preferredRoles'
  | 'preferredLocations'
  | 'expectedSalary'
  | 'resume'
  | 'general';

export interface ProfileSuggestion {
  field: SuggestionField;
  priority: SuggestionPriority;
  title: string;
  description: string;
  // Optional concrete value the UI can offer to apply with one tap.
  suggestedValue?: string | string[];
}

export interface ProfileOptimizationResult {
  completenessScore: number;
  suggestions: ProfileSuggestion[];
  usedAi: boolean;
  generatedAt: Date;
}

const cacheKey = (userId: string) => `profile-opt:${userId}`;

const profileBlock = (user: IUser): string => {
  const p = user.profile;
  return [
    `Name: ${p.fullName}`,
    p.headline ? `Headline: ${p.headline}` : 'Headline: (missing)',
    `Experience: ${p.experienceYears} year${p.experienceYears === 1 ? '' : 's'}`,
    p.skills?.length ? `Skills (${p.skills.length}): ${p.skills.join(', ')}` : 'Skills: (none)',
    p.preferredRoles?.length
      ? `Preferred roles: ${p.preferredRoles.join(', ')}`
      : 'Preferred roles: (none)',
    p.preferredLocations?.length
      ? `Preferred locations: ${p.preferredLocations.join(', ')}`
      : 'Preferred locations: (none)',
    p.preferredJobTypes?.length
      ? `Preferred job types: ${p.preferredJobTypes.join(', ')}`
      : 'Preferred job types: (none)',
    p.expectedSalaryMin ? `Expected min salary: ₹${p.expectedSalaryMin}` : 'Expected salary: (not set)',
    p.resumeUrl || p.resumeFile ? 'Resume: uploaded' : 'Resume: (not uploaded)',
    p.resumeText ? `Resume text length: ${p.resumeText.length} chars` : 'Resume text: (not parsed)',
  ].join('\n');
};

/**
 * Heuristic completeness score — drives both the home banner and the
 * "low priority" suggestions when the LLM is unavailable.
 */
const computeCompletenessScore = (user: IUser): number => {
  const p = user.profile;
  let score = 0;
  if (p.fullName) score += 5;
  if (p.headline && p.headline.length >= 10) score += 10;
  if (p.experienceYears > 0) score += 5;
  if ((p.skills?.length ?? 0) >= 5) score += 20;
  else if ((p.skills?.length ?? 0) >= 1) score += 10;
  if ((p.preferredRoles?.length ?? 0) > 0) score += 10;
  if ((p.preferredLocations?.length ?? 0) > 0) score += 10;
  if ((p.preferredJobTypes?.length ?? 0) > 0) score += 5;
  if (p.expectedSalaryMin && p.expectedSalaryMin > 0) score += 5;
  if (p.resumeUrl || p.resumeFile) score += 20;
  if (p.resumeText && p.resumeText.length > 200) score += 10;
  return Math.max(0, Math.min(100, score));
};

const heuristicSuggestions = (user: IUser): ProfileSuggestion[] => {
  const p = user.profile;
  const out: ProfileSuggestion[] = [];

  if (!p.headline || p.headline.length < 10) {
    out.push({
      field: 'headline',
      priority: 'high',
      title: 'Add a clear headline',
      description:
        'A 1-line headline (role + 2 specialties) is the first thing hirers see when scanning applicants.',
    });
  }
  if ((p.skills?.length ?? 0) < 5) {
    out.push({
      field: 'skills',
      priority: 'high',
      title: 'Add more skills',
      description:
        'Profiles with 5–10 well-chosen skills get matched to ~3× more jobs by our matcher.',
    });
  }
  if (!p.resumeUrl && !p.resumeFile) {
    out.push({
      field: 'resume',
      priority: 'high',
      title: 'Upload a resume',
      description:
        'You can\'t auto-apply or one-click apply to native jobs without a resume on file.',
    });
  }
  if ((p.preferredRoles?.length ?? 0) === 0) {
    out.push({
      field: 'preferredRoles',
      priority: 'medium',
      title: 'Set preferred roles',
      description:
        'Helps the matcher understand which job titles to prioritise and is required for Auto-Apply.',
    });
  }
  if ((p.preferredLocations?.length ?? 0) === 0) {
    out.push({
      field: 'preferredLocations',
      priority: 'medium',
      title: 'Pick preferred cities',
      description:
        'Adds location-fit weight to your match score and unlocks the "Jobs near me" home section.',
    });
  }
  if (!p.expectedSalaryMin) {
    out.push({
      field: 'expectedSalary',
      priority: 'low',
      title: 'Set a minimum salary',
      description:
        'Lets Auto-Apply skip listings below your floor so your applications stay on-target.',
    });
  }
  return out;
};

/**
 * Returns improvement suggestions for the user's profile. Cached for 24h
 * so the home banner doesn't burn tokens on every refresh; bust the
 * cache by writing the profile (UserService.updateProfile already
 * invalidates the user-cache).
 *
 * Falls back to heuristic suggestions when the LLM is not configured —
 * so the feature still works in dev/CI.
 */
export const optimizeProfile = async (
  user: IUser,
): Promise<ProfileOptimizationResult> => {
  const id = user._id.toString();
  const cached = await redis.get(cacheKey(id));
  if (cached) {
    try {
      return JSON.parse(cached) as ProfileOptimizationResult;
    } catch {
      // fall through and recompute
    }
  }

  const completenessScore = computeCompletenessScore(user);
  const heuristics = heuristicSuggestions(user);

  if (!client) {
    const result: ProfileOptimizationResult = {
      completenessScore,
      suggestions: heuristics,
      usedAi: false,
      generatedAt: new Date(),
    };
    await redis.setex(cacheKey(id), 60 * 60 * 6, JSON.stringify(result));
    return result;
  }

  const system = `You are a career coach helping job seekers fix their profile. Output strict JSON:
{
  "suggestions": [
    {
      "field": "headline" | "skills" | "experience" | "preferredRoles" | "preferredLocations" | "expectedSalary" | "resume" | "general",
      "priority": "high" | "medium" | "low",
      "title": "Short imperative title (3–8 words)",
      "description": "1–2 sentences explaining why this matters and what to do.",
      "suggestedValue": "(optional) concrete suggested text or array of items"
    }
  ]
}

Rules:
- Output ONLY JSON, no prose, no markdown fences.
- 3–6 suggestions, ordered most-impactful first.
- Be specific and actionable; never use the word "consider".
- Don't invent data the candidate didn't share. If the profile is sparse, suggest filling sections.
- If the candidate already has a section well-filled, don't suggest re-doing it.`;

  const prompt = `Candidate profile:
${profileBlock(user)}

Generate suggestions now.`;

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = res.content[0];
    const raw =
      block && block.type === 'text' && typeof block.text === 'string'
        ? block.text.trim()
        : '';
    let suggestions: ProfileSuggestion[] = [];
    try {
      const parsed = JSON.parse(raw) as { suggestions?: unknown };
      const arr = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
      // Sanitise — never trust the LLM blindly.
      suggestions = arr
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .slice(0, 8)
        .map((x) => ({
          field: ([
            'headline',
            'skills',
            'experience',
            'preferredRoles',
            'preferredLocations',
            'expectedSalary',
            'resume',
            'general',
          ].includes(x.field as string)
            ? x.field
            : 'general') as SuggestionField,
          priority: (['high', 'medium', 'low'].includes(x.priority as string)
            ? x.priority
            : 'medium') as SuggestionPriority,
          title: String(x.title ?? '').slice(0, 100),
          description: String(x.description ?? '').slice(0, 600),
          suggestedValue: Array.isArray(x.suggestedValue)
            ? (x.suggestedValue as unknown[]).map(String).slice(0, 20)
            : typeof x.suggestedValue === 'string'
              ? x.suggestedValue.slice(0, 600)
              : undefined,
        }))
        .filter((s) => s.title.length >= 3);
    } catch (e) {
      logger.warn(`profileOptimizer JSON parse failed: ${(e as Error).message}`);
    }

    if (suggestions.length === 0) suggestions = heuristics;

    const result: ProfileOptimizationResult = {
      completenessScore,
      suggestions,
      usedAi: true,
      generatedAt: new Date(),
    };
    await redis.setex(cacheKey(id), 60 * 60 * 24, JSON.stringify(result));
    return result;
  } catch (err) {
    logger.warn(`profileOptimizer failed: ${(err as Error).message}`);
    return {
      completenessScore,
      suggestions: heuristics,
      usedAi: false,
      generatedAt: new Date(),
    };
  }
};
