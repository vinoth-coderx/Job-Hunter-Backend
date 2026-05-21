import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generateJson, isProviderEnabled } from './providers';
import { cleanPromptText } from './promptGuard.service';

/**
 * AI-generated short company description for the hirer onboarding flow.
 * Hirers fill in the company name + a few prompts (industry, size, what
 * they do); we return a 2-3 paragraph "About" blurb they can edit before
 * saving. Speeds up first-time setup — the description field is one of
 * the biggest dropoff points in profile completion.
 *
 * Routed through Groq (lite tier) for speed/cost; cached 30d per
 * sha256(prompt) so the same input doesn't regenerate.
 */

export interface CompanyDescriptionInput {
  companyName: string;
  industry?: string;
  sizeBand?: string;
  hqLocation?: string;
  whatYouDo?: string;
  toneHint?: 'professional' | 'casual' | 'startup';
}

export interface CompanyDescriptionResult {
  description: string;
  usedAi: boolean;
  cached: boolean;
}

const cacheKey = (input: CompanyDescriptionInput): string => {
  const norm = [
    input.companyName.toLowerCase().trim(),
    (input.industry || '').toLowerCase().trim(),
    (input.sizeBand || '').toLowerCase().trim(),
    (input.hqLocation || '').toLowerCase().trim(),
    (input.whatYouDo || '').toLowerCase().trim(),
    input.toneHint || 'professional',
  ].join('||');
  const hash = crypto
    .createHash('sha256')
    .update(norm)
    .digest('hex')
    .slice(0, 24);
  return `ai:companydesc:${hash}`;
};

const SYSTEM_PROMPT = `You write the "About" section of a company profile for an Indian job platform. Output STRICT JSON only.

Schema: {"description": "<2-3 paragraphs of plain text, no markdown>"}

Rules:
- 2-3 paragraphs total, ~120-220 words.
- Paragraph 1: who the company is and what they do.
- Paragraph 2: how they work / what makes them distinct (only what the hirer hinted at — never fabricate facts like funding rounds, awards, employee counts, founders).
- Paragraph 3 (optional): a one-line invitation to candidates to apply.
- Tone matches the requested toneHint (default professional).
- Never invent specific numbers, named clients, named investors, or revenue.
- Avoid hype words ("rockstar", "ninja", "unicorn", "world-class", "cutting-edge").
- Plain prose only — no bullets, no markdown, no headings.`;

export const generateCompanyDescription = async (
  input: CompanyDescriptionInput,
  ctx: { userId?: string } = {},
): Promise<CompanyDescriptionResult> => {
  const companyName = (input.companyName || '').trim();
  if (companyName.length < 2) {
    return { description: '', usedAi: false, cached: false };
  }

  // Sanitise free-form fields against prompt-injection.
  const safeWhatYouDo = input.whatYouDo
    ? cleanPromptText(input.whatYouDo, 'company_description', ctx.userId).trim()
    : '';

  const safeInput: CompanyDescriptionInput = {
    ...input,
    whatYouDo: safeWhatYouDo,
  };

  const ck = cacheKey(safeInput);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      const parsed = JSON.parse(cached) as { description: string };
      return { description: parsed.description, usedAi: true, cached: true };
    }
  } catch (err) {
    logger.warn(`companyDescription cache read: ${(err as Error).message}`);
  }

  const preferred: 'groq' | undefined = isProviderEnabled('groq')
    ? 'groq'
    : undefined;
  if (
    !preferred &&
    !isProviderEnabled('gemini')
  ) {
    return { description: '', usedAi: false, cached: false };
  }

  const userPrompt = `Generate the About section for:
- Company name: ${companyName}
- Industry: ${input.industry || 'unspecified'}
- Size band: ${input.sizeBand || 'unspecified'}
- HQ location: ${input.hqLocation || 'unspecified'}
- What they do (hirer's words): ${safeWhatYouDo || 'unspecified'}
- Tone: ${input.toneHint || 'professional'}

Return the JSON now.`;

  try {
    const parsed = await generateJson<{ description?: unknown }>(
      {
        provider: preferred,
        tier: 'lite',
        system: SYSTEM_PROMPT,
        user: userPrompt,
        json: true,
        maxTokens: 700,
        temperature: 0.55,
      },
      { userId: ctx.userId, feature: 'company_description' },
    );

    const desc =
      parsed && typeof parsed.description === 'string'
        ? parsed.description.trim().slice(0, 3000)
        : '';
    if (!desc || desc.length < 50) {
      return { description: '', usedAi: false, cached: false };
    }

    try {
      await redis.setex(
        ck,
        60 * 60 * 24 * 30,
        JSON.stringify({ description: desc }),
      );
    } catch (err) {
      logger.warn(`companyDescription cache write: ${(err as Error).message}`);
    }
    return { description: desc, usedAi: true, cached: false };
  } catch (err) {
    logger.warn(`companyDescription failed: ${(err as Error).message}`);
    return { description: '', usedAi: false, cached: false };
  }
};
