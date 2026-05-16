import { GoogleGenAI } from '@google/genai';
import { GEMINI_MODEL_LITE, GEMINI_MODEL_SMART } from '../../../config/constants';
import { getAppConfig } from '../../config/config.service';
import { logger } from '../../../utils/logger';
import {
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
  AiProviderAuthError,
  AiProviderQuotaError,
} from './types';

let cached: { key: string; client: GoogleGenAI } | null = null;
const getClient = (): GoogleGenAI | null => {
  const key = getAppConfig('GEMINI_API_KEY');
  if (!key) return null;
  if (cached && cached.key === key) return cached.client;
  cached = { key, client: new GoogleGenAI({ apiKey: key }) };
  return cached.client;
};

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

const isAuthError = (err: unknown): boolean => {
  const msg = (err as Error)?.message?.toLowerCase() ?? '';
  return (
    msg.includes('api key not valid') ||
    msg.includes('api_key_invalid') ||
    msg.includes('permission_denied') ||
    msg.includes('unauthenticated') ||
    msg.includes(' 401') ||
    msg.includes(' 403')
  );
};

export const geminiProvider: AiProvider = {
  name: 'gemini',
  // Re-evaluated each access so admin-rotated keys flip the flag without
  // a process restart. Cheap call: just a Map.get inside getAppConfig.
  get enabled(): boolean {
    return getClient() !== null;
  },

  async generate(opts: AiGenerateOptions): Promise<AiGenerateResult> {
    const client = getClient();
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
      if (isAuthError(err)) {
        logger.warn(
          `Gemini auth error (key rejected): ${(err as Error).message}`,
        );
        throw new AiProviderAuthError(
          'Gemini API key is invalid or revoked — rotate it in the admin /ai page',
        );
      }
      if (isQuotaError(err)) {
        logger.warn(`Gemini quota error: ${(err as Error).message}`);
        throw new AiProviderQuotaError('Gemini API quota or rate limit reached');
      }
      throw err;
    }
  },
};
