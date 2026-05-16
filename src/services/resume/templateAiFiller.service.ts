import crypto from 'crypto';
import { redis } from '../../config/redis';
import { logger } from '../../utils/logger';
import { IUser } from '../../models/User';
import {
  generateJson,
  isAiEnabled,
  recordCacheHit,
} from '../ai/providers';
import { syncAllProvidersToAppConfig } from '../ai/aiKeySync.service';

/**
 * AI-enhanced fill for the seeker's chosen resume template.
 *
 * The plain `fillPlaceholders` substitutes `{{tokens}}` with raw profile
 * fields — fine when the seeker has spent time on the "My Profile" form,
 * but it produces a thin-looking PDF for someone who only filled the
 * basics (name, email, skills, experienceYears). This service hands
 * those raw fields to the LLM and asks it to expand them into polished,
 * ATS-friendly resume copy:
 *
 *   - Professional summary (3 sentences, action-oriented)
 *   - Work experience (HTML <ul><li> bullets per role, quantified
 *     impact where possible)
 *   - Education / projects / certifications HTML blocks
 *
 * Output is keyed off `{userId, templateSlug}` and cached in Redis for
 * 24h so a seeker who downloads-then-tweaks-then-downloads doesn't burn
 * credits each time. Cache hits still log to AiUsageLog via
 * `recordCacheHit` so the dashboard's cache-savings ratio stays
 * honest.
 *
 * On any failure (no AI provider, quota error, JSON parse fail) we
 * return `null`. The caller falls back to plain `fillPlaceholders` so
 * the download never breaks just because the AI lane is unavailable.
 */

const FEATURE = 'resume_template_fill';
const CACHE_TTL_SEC = 60 * 60 * 24; // 24h

export interface AiTemplateSlots {
  fullname: string;
  firstname: string;
  lastname: string;
  email: string;
  phone: string;
  headline: string;
  profession: string;
  location: string;
  summary: string;
  skills: string;
  /** HTML — one or more <div> blocks per role with bullets. */
  experience: string;
  /** HTML — one <div> per degree. */
  education: string;
  /** HTML — one <div> per project. */
  projects: string;
  certifications: string;
  linkedin: string;
  github: string;
  portfolio: string;
  company: string;
}

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

const buildUserPrompt = (user: IUser): string => {
  const p = user.profile ?? ({} as IUser['profile']);
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

interface AiResponse {
  summary?: string;
  experience?: string;
  education?: string;
  projects?: string;
  certifications?: string;
  skills?: string;
}

const sanitize = (raw: AiResponse | null | undefined): AiResponse => ({
  summary: typeof raw?.summary === 'string' ? raw.summary : '',
  experience: typeof raw?.experience === 'string' ? raw.experience : '',
  education: typeof raw?.education === 'string' ? raw.education : '',
  projects: typeof raw?.projects === 'string' ? raw.projects : '',
  certifications:
    typeof raw?.certifications === 'string' ? raw.certifications : '',
  skills: typeof raw?.skills === 'string' ? raw.skills : '',
});

const cacheKey = (userId: string, templateSlug: string, contentHash: string): string =>
  `template:ai:fill:${userId}:${templateSlug}:${contentHash}`;

/**
 * Hash of the seeker's resume-relevant fields. Invalidates the AI
 * output cache when any of these change so the next download reflects
 * the edit instead of serving stale text.
 */
const hashUserProfile = (user: IUser): string => {
  const p = user.profile ?? ({} as IUser['profile']);
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
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
};

/**
 * Returns enhanced slot HTML for the template, or `null` if AI is
 * disabled / unavailable / the call failed. Callers fall back to the
 * plain `fillPlaceholders` path on null.
 */
export const aiEnhanceTemplateContent = async (
  user: IUser,
  templateSlug: string,
): Promise<AiResponse | null> => {
  // Self-heal: AI keys live in the AiKey collection (admin `/ai` page).
  // A boot-time bridge projects the winning key into AppConfig, which is
  // what the providers actually read. If the admin added keys after boot
  // — or the bridge errored silently — `isAiEnabled()` would say "no AI"
  // even though credentials are sitting right there. Re-running the
  // bridge here is cheap (a single Mongo query per provider) and makes
  // the template-fill self-heal on the next download attempt.
  await syncAllProvidersToAppConfig().catch((err) => {
    logger.warn(
      `templateAiFiller: aiKey sync failed — falling back to AppConfig as-is: ${(err as Error).message}`,
    );
  });

  if (!isAiEnabled()) {
    logger.info(
      'templateAiFiller: AI disabled (no provider has a valid key in AppConfig/AiKey). Falling back to plain fill.',
    );
    return null;
  }

  const userId = user._id.toString();
  const contentHash = hashUserProfile(user);
  const key = cacheKey(userId, templateSlug, contentHash);

  try {
    const cached = await redis.get(key);
    if (cached) {
      recordCacheHit({ userId, feature: FEATURE }, 'smart');
      return JSON.parse(cached) as AiResponse;
    }
  } catch (e) {
    logger.warn(`templateAiFiller cache read failed: ${(e as Error).message}`);
  }

  try {
    const parsed = await generateJson<AiResponse>(
      {
        tier: 'smart',
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(user),
        // Roughly 1 PDF's worth — summary + 2-3 jobs + edu + projects.
        maxTokens: 1800,
        temperature: 0.3,
      },
      { userId, feature: FEATURE },
    );
    if (!parsed) return null;
    const clean = sanitize(parsed);

    try {
      await redis.setex(key, CACHE_TTL_SEC, JSON.stringify(clean));
    } catch (e) {
      logger.warn(`templateAiFiller cache write failed: ${(e as Error).message}`);
    }
    return clean;
  } catch (err) {
    logger.warn(`templateAiFiller generate failed: ${(err as Error).message}`);
    return null;
  }
};
