import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generateJson, isProviderEnabled } from './providers';
import type { IUser } from '../../models/User';
import type { IJob } from '../../models/Job';

/**
 * AI recruiter outreach drafter. Given a (job, candidate) pair, returns
 * 2-3 short opener messages the hirer can paste into a chat to reach
 * out. Tailored to the candidate's headline + skills overlap with the
 * job — never invents details the resume doesn't expose.
 *
 * Routed through Groq because the call is short and high-volume (one
 * per "view candidate" action). Cached 24h server-side by hash(jobId
 * + candidateUserId + jobUpdatedAt) so re-opening the same candidate
 * card is free of quota.
 *
 * Fallback returns a single generic opener so the UI works when the
 * LLM is down.
 */

export interface OutreachDraft {
  /** Short label for the variant ("Direct", "Curious", "Mutual fit"). */
  label: string;
  /** The actual message body the hirer would send. 50-110 words. */
  body: string;
}

export interface OutreachResult {
  drafts: OutreachDraft[];
  usedAi: boolean;
  cached: boolean;
}

const cacheKey = (
  jobId: string,
  candidateId: string,
  jobUpdatedAt: Date,
): string => {
  const hash = crypto
    .createHash('sha256')
    .update(`${jobId}|${candidateId}|${jobUpdatedAt.toISOString()}`)
    .digest('hex')
    .slice(0, 24);
  return `ai:outreach:${hash}`;
};

const SYSTEM_PROMPT = `You draft SHORT recruiter outreach messages a hirer can paste into an in-app chat with a candidate they want to recruit.

RULES:
- Output STRICT JSON: {"drafts": [{"label": "...", "body": "..."}, ...]}.
- Generate 2-3 variants. Each labelled with a short angle ("Direct", "Curious", "Mutual fit", "Project-led" — pick what fits).
- Each body: 50-110 words. Plain English. No recruiter clichés ("rockstar", "ninja", "exciting opportunity").
- Open by addressing the candidate by first name.
- Mention the SPECIFIC job title and one concrete reason their profile fits (cite a skill they have that the job needs, or a project relevant to the role).
- End with one clear next step ("open to a quick chat?", "want me to share the JD?").
- Don't promise compensation, equity, or specific interview rounds.
- Don't pretend to know things outside the input (no "I saw your LinkedIn", no fake mutual connections).
- Output ONLY the JSON, no markdown fences, no prose.`;

const sanitize = (raw: unknown): OutreachDraft[] => {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { drafts?: unknown };
  if (!Array.isArray(obj.drafts)) return [];
  const out: OutreachDraft[] = [];
  for (const item of obj.drafts) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const body = typeof r.body === 'string' ? r.body.trim().slice(0, 1500) : '';
    if (body.length < 30) continue;
    const label =
      typeof r.label === 'string' && r.label.trim().length > 0
        ? r.label.trim().slice(0, 30)
        : 'Draft';
    out.push({ label, body });
    if (out.length >= 3) break;
  }
  return out;
};

const fallback = (
  candidate: Pick<IUser['profile'], 'fullName'>,
  job: Pick<IJob, 'title'>,
): OutreachDraft[] => {
  const firstName =
    (candidate.fullName || '').split(/\s+/)[0]?.trim() || 'there';
  return [
    {
      label: 'Direct',
      body:
        `Hi ${firstName} — I'm hiring for "${job.title}" and your background looks like a strong fit. ` +
        `Open to a quick chat about the role? Happy to share the JD if it sounds interesting.`,
    },
  ];
};

export interface DraftOutreachArgs {
  job: IJob;
  candidate: IUser;
  userId: string;
}

export const peekCachedOutreach = async (
  jobId: string,
  candidateId: string,
  jobUpdatedAt: Date,
): Promise<OutreachDraft[] | null> => {
  try {
    const raw = await redis.get(cacheKey(jobId, candidateId, jobUpdatedAt));
    if (!raw) return null;
    return JSON.parse(raw) as OutreachDraft[];
  } catch {
    return null;
  }
};

export const draftRecruiterOutreach = async (
  args: DraftOutreachArgs,
): Promise<OutreachResult> => {
  const { job, candidate, userId } = args;

  const ck = cacheKey(
    job._id.toString(),
    candidate._id.toString(),
    job.updatedAt,
  );
  try {
    const cached = await redis.get(ck);
    if (cached) {
      const parsed = JSON.parse(cached) as OutreachDraft[];
      return { drafts: parsed, usedAi: true, cached: true };
    }
  } catch (err) {
    logger.warn(`outreach cache read: ${(err as Error).message}`);
  }

  const preferred: 'groq' | undefined = isProviderEnabled('groq')
    ? 'groq'
    : undefined;
  if (
    !preferred &&
    !isProviderEnabled('gemini') &&
    !isProviderEnabled('claude')
  ) {
    return {
      drafts: fallback(candidate.profile, job),
      usedAi: false,
      cached: false,
    };
  }

  const candidateBlock = [
    `Name: ${candidate.profile.fullName}`,
    candidate.profile.headline ? `Headline: ${candidate.profile.headline}` : null,
    candidate.profile.experienceYears
      ? `Experience: ${candidate.profile.experienceYears} year${candidate.profile.experienceYears === 1 ? '' : 's'}`
      : null,
    `Skills: ${(candidate.profile.skills ?? []).slice(0, 25).join(', ') || '(none listed)'}`,
  ]
    .filter(Boolean)
    .join('\n');

  const jobBlock = [
    `Title: ${job.title}`,
    `Required skills: ${(job.skills ?? []).slice(0, 25).join(', ') || '(none listed)'}`,
    `Location: ${job.location}`,
    `Description (excerpt): ${(job.description || '').slice(0, 1500)}`,
  ].join('\n');

  try {
    const parsed = await generateJson<unknown>(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEM_PROMPT,
        user: `JOB\n${jobBlock}\n\nCANDIDATE\n${candidateBlock}\n\nReturn the JSON now.`,
        json: true,
        maxTokens: 800,
        temperature: 0.55,
      },
      { userId, feature: 'recruiter_outreach' },
    );

    const drafts = sanitize(parsed);
    if (drafts.length === 0) {
      return {
        drafts: fallback(candidate.profile, job),
        usedAi: false,
        cached: false,
      };
    }

    try {
      await redis.setex(ck, 60 * 60 * 24, JSON.stringify(drafts));
    } catch (err) {
      logger.warn(`outreach cache write: ${(err as Error).message}`);
    }
    return { drafts, usedAi: true, cached: false };
  } catch (err) {
    logger.warn(`outreach draft failed: ${(err as Error).message}`);
    return {
      drafts: fallback(candidate.profile, job),
      usedAi: false,
      cached: false,
    };
  }
};
