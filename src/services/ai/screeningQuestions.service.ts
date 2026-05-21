import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generateJson, isProviderEnabled } from './providers';
import type { ScreeningQuestionType } from '../../types';

/**
 * AI-generated screening questions for a hirer's job post. The hirer
 * can paste a JD draft and get 3-5 candidate questions back, then keep
 * / edit / delete each one before saving the listing. The shape mirrors
 * `IScreeningQuestion` in models/Job.ts so the UI can drop the result
 * straight into the existing screening editor.
 *
 * Routed through Groq (short structured output, low latency). Cached
 * 24h server-side by sha256(title + skills) so editing a draft and
 * re-generating doesn't burn a fresh call when nothing meaningful
 * changed.
 *
 * Fallback returns a generic 2-question template ("Why are you
 * interested?" + "What's your notice period?") so the UI works even
 * when the LLM is down.
 */

export interface GeneratedScreeningQuestion {
  question: string;
  type: ScreeningQuestionType;
  options?: string[];
  isRequired: boolean;
}

export interface ScreeningGenerationResult {
  questions: GeneratedScreeningQuestion[];
  usedAi: boolean;
  cached: boolean;
}

const cacheKey = (
  title: string,
  description: string,
  skills: string[],
): string => {
  // Description doesn't go into the key by itself — too volatile across
  // edits. We hash the title + skills (the stable signal) so a typo fix
  // in the JD body still gets a cache hit.
  const skillsKey = [...skills]
    .map((s) => s.toLowerCase().trim())
    .filter((s) => s.length > 0)
    .sort()
    .slice(0, 30)
    .join(',');
  const descPrefix = (description || '').slice(0, 240).toLowerCase();
  const hash = crypto
    .createHash('sha256')
    .update(`${title.toLowerCase().trim()}||${skillsKey}||${descPrefix}`)
    .digest('hex')
    .slice(0, 24);
  return `ai:screen:${hash}`;
};

const SYSTEM_PROMPT = `You generate SHORT screening questions a recruiter can ask applicants for a specific job.

RULES:
- Output STRICT JSON only: {"questions": [...]}.
- Generate 3-5 questions. NO MORE.
- Each question is 6-20 words. Plain English, no jargon, no idioms.
- Mix types based on what's useful:
  - "yes_no" for must-haves you can verify quickly (notice period, location, eligibility).
  - "mcq" only when the answer space is genuinely closed (years bands, location preference). Provide 3-4 options.
  - "text" for open-ended qualifiers (why they're interested, biggest project).
- "isRequired" should be true ONLY for the must-have screeners (notice period, location). Default false otherwise.
- DO NOT ask anything illegal or discriminatory (age, marital status, religion, caste, gender).
- DO NOT ask for information already in the resume (years of experience the resume covers, current company).
- DO NOT ask multi-part questions ("X and Y") — split them.
- Output ONLY the JSON, no markdown fences, no prose.

Schema for each item:
{
  "question": "the question text",
  "type": "text" | "mcq" | "yes_no",
  "options": ["..."] | omitted unless type=mcq,
  "isRequired": true | false
}`;

const sanitize = (raw: unknown): GeneratedScreeningQuestion[] => {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { questions?: unknown };
  if (!Array.isArray(obj.questions)) return [];
  const out: GeneratedScreeningQuestion[] = [];
  for (const item of obj.questions) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const question =
      typeof r.question === 'string' ? r.question.trim().slice(0, 500) : '';
    if (question.length < 3) continue;
    const t = typeof r.type === 'string' ? r.type : '';
    const type: ScreeningQuestionType =
      t === 'mcq' || t === 'yes_no' ? t : 'text';
    let options: string[] | undefined;
    if (type === 'mcq' && Array.isArray(r.options)) {
      options = r.options
        .map((o) => (typeof o === 'string' ? o.trim() : ''))
        .filter((o) => o.length > 0)
        .slice(0, 10);
      if (options.length < 2) {
        // MCQ with no options is meaningless — drop the row.
        continue;
      }
    }
    out.push({
      question,
      type,
      options,
      isRequired: r.isRequired === true,
    });
    if (out.length >= 5) break;
  }
  return out;
};

const heuristicFallback = (): GeneratedScreeningQuestion[] => [
  {
    question: 'What is your notice period in days?',
    type: 'text',
    isRequired: true,
  },
  {
    question: 'Are you open to relocating for this role?',
    type: 'yes_no',
    isRequired: false,
  },
];

export interface GenerateScreeningArgs {
  title: string;
  description: string;
  skills: string[];
  userId?: string;
}

export const generateScreeningQuestions = async (
  args: GenerateScreeningArgs,
): Promise<ScreeningGenerationResult> => {
  const title = (args.title || '').trim();
  if (title.length < 3) {
    return {
      questions: heuristicFallback(),
      usedAi: false,
      cached: false,
    };
  }

  const ck = cacheKey(title, args.description, args.skills);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as GeneratedScreeningQuestion[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return { questions: parsed, usedAi: true, cached: true };
        }
      } catch {
        // fall through and recompute
      }
    }
  } catch (err) {
    logger.warn(
      `screeningQuestions cache read: ${(err as Error).message}`,
    );
  }

  const preferred: 'groq' | undefined = isProviderEnabled('groq')
    ? 'groq'
    : undefined;
  if (
    !preferred &&
    !isProviderEnabled('gemini')
  ) {
    return {
      questions: heuristicFallback(),
      usedAi: false,
      cached: false,
    };
  }

  const userPrompt = [
    `Job title: ${title.slice(0, 200)}`,
    args.skills.length > 0
      ? `Required skills: ${args.skills.slice(0, 25).join(', ')}`
      : null,
    `Description (excerpt):\n"""${(args.description || '').slice(0, 2000)}"""`,
    'Return the JSON now.',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const parsed = await generateJson<unknown>(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEM_PROMPT,
        user: userPrompt,
        json: true,
        maxTokens: 600,
        temperature: 0.5,
      },
      { userId: args.userId, feature: 'screening_questions' },
    );

    const questions = sanitize(parsed);
    if (questions.length === 0) {
      return {
        questions: heuristicFallback(),
        usedAi: false,
        cached: false,
      };
    }

    try {
      await redis.setex(ck, 60 * 60 * 24, JSON.stringify(questions));
    } catch (err) {
      logger.warn(
        `screeningQuestions cache write: ${(err as Error).message}`,
      );
    }
    return { questions, usedAi: true, cached: false };
  } catch (err) {
    logger.warn(`screeningQuestions failed: ${(err as Error).message}`);
    return {
      questions: heuristicFallback(),
      usedAi: false,
      cached: false,
    };
  }
};

/**
 * Cheap cache probe — controllers call this before `enforceQuota` so a
 * cache hit doesn't burn a quota slot.
 */
export const peekCachedScreeningQuestions = async (
  title: string,
  description: string,
  skills: string[],
): Promise<GeneratedScreeningQuestion[] | null> => {
  if (!title || title.length < 3) return null;
  try {
    const cached = await redis.get(cacheKey(title, description, skills));
    if (!cached) return null;
    return JSON.parse(cached) as GeneratedScreeningQuestion[];
  } catch {
    return null;
  }
};
