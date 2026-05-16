import axios, { AxiosError, AxiosInstance } from 'axios';
import { getAppConfig } from '../../config/config.service';
import { logger } from '../../../utils/logger';
import {
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
  AiProviderAuthError,
  AiProviderQuotaError,
} from './types';

/**
 * Groq provider — used as the cheap-fast lane for moderation triage,
 * lightweight rewrites, and skill extraction. Talks to Groq's
 * OpenAI-compatible Chat Completions endpoint via axios so we don't
 * need to add another SDK dependency.
 *
 * Tier mapping:
 *   - "lite"  → Llama 3.1 8B Instant      (sub-second, ~$0.05/$0.08 per M)
 *   - "smart" → Llama 3.3 70B Versatile   (still fast, ~$0.59/$0.79 per M)
 *
 * Both model IDs and the base URL are overridable via AppConfig
 * (GROQ_MODEL_LITE, GROQ_MODEL_SMART, GROQ_BASE_URL) so the admin can
 * swap to a newer Llama / Mixtral build without a deploy.
 */

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL_LITE = 'llama-3.1-8b-instant';
const DEFAULT_MODEL_SMART = 'llama-3.3-70b-versatile';

let cached: { key: string; baseUrl: string; client: AxiosInstance } | null = null;

const getClient = (): AxiosInstance | null => {
  const key = getAppConfig('GROQ_API_KEY');
  if (!key) return null;
  const baseUrl = getAppConfig('GROQ_BASE_URL') || DEFAULT_BASE_URL;
  if (cached && cached.key === key && cached.baseUrl === baseUrl) return cached.client;
  cached = {
    key,
    baseUrl,
    client: axios.create({
      baseURL: baseUrl,
      timeout: 30_000,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
    }),
  };
  return cached.client;
};

const modelFor = (tier: 'lite' | 'smart'): string => {
  if (tier === 'smart') return getAppConfig('GROQ_MODEL_SMART') || DEFAULT_MODEL_SMART;
  return getAppConfig('GROQ_MODEL_LITE') || DEFAULT_MODEL_LITE;
};

const isQuotaError = (err: unknown): boolean => {
  const ax = err as AxiosError;
  if (ax?.isAxiosError && ax.response?.status === 429) return true;
  const msg = (err as Error)?.message?.toLowerCase() ?? '';
  return msg.includes('rate') || msg.includes('quota') || msg.includes('429');
};

const isAuthError = (err: unknown): boolean => {
  const ax = err as AxiosError;
  if (ax?.isAxiosError) {
    const status = ax.response?.status;
    if (status === 401 || status === 403) return true;
  }
  const msg = (err as Error)?.message?.toLowerCase() ?? '';
  return (
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('unauthorized') ||
    msg.includes(' 401') ||
    msg.includes(' 403')
  );
};

interface GroqChatResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export const groqProvider: AiProvider = {
  name: 'groq',
  get enabled(): boolean {
    return getClient() !== null;
  },

  async generate(opts: AiGenerateOptions): Promise<AiGenerateResult> {
    const client = getClient();
    if (!client) {
      throw new Error('Groq provider disabled: GROQ_API_KEY not set');
    }

    const model = modelFor(opts.tier);

    try {
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: opts.system },
          {
            role: 'user',
            content: opts.json
              ? `${opts.user}\n\nReturn ONLY the JSON object, no prose, no markdown fences.`
              : opts.user,
          },
        ],
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 2048,
      };
      if (opts.json) {
        // Groq honours OpenAI's response_format on Llama 3.x models for
        // strict JSON output; falls back to the system-prompt nudge above
        // on models that don't.
        body.response_format = { type: 'json_object' };
      }

      const res = await client.post<GroqChatResponse>('/chat/completions', body);
      const data = res.data;
      const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
      const text = opts.json
        ? raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        : raw;

      return {
        text,
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      };
    } catch (err) {
      if (isAuthError(err)) {
        logger.warn(`Groq auth error (key rejected): ${(err as Error).message}`);
        throw new AiProviderAuthError(
          'Groq API key is invalid or revoked — rotate it in the admin /ai page',
        );
      }
      if (isQuotaError(err)) {
        logger.warn(`Groq quota error: ${(err as Error).message}`);
        throw new AiProviderQuotaError('Groq API quota or rate limit reached');
      }
      // Surface the upstream error message when available — helps debug
      // model deprecations ("model decommissioned") without log spelunking.
      const ax = err as AxiosError<{ error?: { message?: string } }>;
      if (ax?.isAxiosError && ax.response?.data?.error?.message) {
        throw new Error(`Groq API error: ${ax.response.data.error.message}`);
      }
      throw err;
    }
  },
};
