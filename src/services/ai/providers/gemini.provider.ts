import { GoogleGenAI } from '@google/genai';
import { env } from '../../../config/env';
import { GEMINI_MODEL_LITE, GEMINI_MODEL_SMART } from '../../../config/constants';
import { logger } from '../../../utils/logger';
import {
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
  AiProviderQuotaError,
} from './types';

const client = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;

const modelFor = (tier: 'lite' | 'smart'): string =>
  tier === 'smart' ? GEMINI_MODEL_SMART : GEMINI_MODEL_LITE;

const isQuotaError = (err: unknown): boolean => {
  const msg = (err as Error)?.message?.toLowerCase() ?? '';
  return (
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('429')
  );
};

export const geminiProvider: AiProvider = {
  name: 'gemini',
  enabled: client !== null,

  async generate(opts: AiGenerateOptions): Promise<AiGenerateResult> {
    if (!client) {
      throw new Error('Gemini provider disabled: GEMINI_API_KEY not set');
    }

    const model = modelFor(opts.tier);

    try {
      const res = await client.models.generateContent({
        model,
        contents: opts.user,
        config: {
          systemInstruction: opts.system,
          temperature: opts.temperature ?? 0.4,
          maxOutputTokens: opts.maxTokens ?? 2048,
          ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        },
      });

      const text = (res.text ?? '').trim();
      const usage = res.usageMetadata;

      return {
        text,
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
      };
    } catch (err) {
      if (isQuotaError(err)) {
        logger.warn(`Gemini quota error: ${(err as Error).message}`);
        throw new AiProviderQuotaError('Gemini API quota or rate limit reached');
      }
      throw err;
    }
  },
};
