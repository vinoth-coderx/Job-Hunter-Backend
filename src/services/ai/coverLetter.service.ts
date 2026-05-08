import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { IUser } from '../../models/User';
import { IJob } from '../../models/Job';
import { redis } from '../../config/redis';

const client = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

const MODEL = 'claude-haiku-4-5-20251001';

export type CoverLetterTone = 'professional' | 'friendly' | 'technical';

const cacheKey = (userId: string, jobId: string, tone: string) =>
  `coverletter:${userId}:${jobId}:${tone}`;

const profileBlock = (user: IUser): string => {
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
  ].filter(Boolean) as string[];
  return lines.join('\n');
};

const jobBlock = (job: IJob): string => {
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
  ].filter(Boolean) as string[];
  return lines.join('\n');
};

const TONE_GUIDANCE: Record<CoverLetterTone, string> = {
  professional:
    'Polished and formal. Lead with impact, keep paragraphs tight. No emoji or slang.',
  friendly:
    'Warm and approachable. Conversational while still concise. Sound like a real person, not a template.',
  technical:
    'Specific and concrete. Highlight relevant tech stack overlaps and quantifiable wins. No fluff.',
};

const fallback = (user: IUser, job: IJob): string =>
  `Hi ${job.company} team,

I'm ${user.profile.fullName}${user.profile.headline ? `, a ${user.profile.headline.toLowerCase()}` : ''}, and I'd like to be considered for the ${job.title} role.

${user.profile.experienceYears > 0 ? `With ${user.profile.experienceYears} year${user.profile.experienceYears === 1 ? '' : 's'} of experience` : 'Bringing fresh energy and a strong drive to learn'} ${user.profile.skills?.length ? `working with ${user.profile.skills.slice(0, 4).join(', ')}` : ''}, I'm excited about what your team is building and believe my background lines up well with what you're looking for.

I'd love the chance to discuss how I can contribute. Thanks for considering my application.

— ${user.profile.fullName}`.trim();

/**
 * Generate a per-job cover letter. Cached for 24h per (user, job, tone) so
 * repeated views from the review screen don't spend tokens.
 *
 * Falls back to a deterministic non-AI letter when ANTHROPIC_API_KEY is
 * unset — keeps Auto-Apply functional in environments without an LLM
 * configured (e.g. CI, local dev).
 */
export const generateCoverLetter = async (params: {
  user: IUser;
  job: IJob;
  tone?: CoverLetterTone;
  baseTemplate?: string;
}): Promise<{ letter: string; usedAi: boolean }> => {
  const tone = params.tone ?? 'professional';
  const key = cacheKey(params.user._id.toString(), params.job._id.toString(), tone);

  const cached = await redis.get(key);
  if (cached) return { letter: cached, usedAi: true };

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
    const text =
      block && block.type === 'text' && typeof block.text === 'string'
        ? block.text.trim()
        : '';
    if (!text) {
      return { letter: fallback(params.user, params.job), usedAi: false };
    }
    // 7-day cache. Letters are highly job-specific so this rarely re-runs
    // for the same person/job pair.
    await redis.setex(key, 60 * 60 * 24 * 7, text);
    return { letter: text, usedAi: true };
  } catch (err) {
    logger.warn(`coverLetter failed: ${(err as Error).message}`);
    return { letter: fallback(params.user, params.job), usedAi: false };
  }
};
