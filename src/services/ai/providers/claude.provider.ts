import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../../config/env';
import { CLAUDE_MODEL_LITE, CLAUDE_MODEL_SMART } from '../../../config/constants';
import { logger } from '../../../utils/logger';
import {
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
  AiProviderQuotaError,
} from './types';

const client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;

const modelFor = (tier: 'lite' | 'smart'): string =>
  tier === 'smart' ? CLAUDE_MODEL_SMART : CLAUDE_MODEL_LITE;

const isQuotaError = (err: unknown): boolean => {
  const msg = (err as Error)?.message?.toLowerCase() ?? '';
  const status = (err as { status?: number })?.status;
  return status === 429 || msg.includes('rate') || msg.includes('quota');
};

export const claudeProvider: AiProvider = {
  name: 'claude',
  enabled: client !== null,

  async generate(opts: AiGenerateOptions): Promise<AiGenerateResult> {
    if (!client) {
      throw new Error('Claude provider disabled: ANTHROPIC_API_KEY not set');
    }

    const model = modelFor(opts.tier);
    const userText = opts.json
      ? `${opts.user}\n\nReturn ONLY the JSON object, no prose, no markdown fences.`
      : opts.user;

    try {
      const res = await client.messages.create({
        model,
        max_tokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.4,
        system: opts.system,
        messages: [{ role: 'user', content: userText }],
      });

      const block = res.content[0];
      const raw =
        block && block.type === 'text' && typeof block.text === 'string' ? block.text.trim() : '';
      const text = opts.json
        ? raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
        : raw;

      return {
        text,
        inputTokens: res.usage?.input_tokens,
        outputTokens: res.usage?.output_tokens,
      };
    } catch (err) {
      if (isQuotaError(err)) {
        logger.warn(`Claude quota error: ${(err as Error).message}`);
        throw new AiProviderQuotaError('Claude API quota or rate limit reached');
      }
      throw err;
    }
  },
};
