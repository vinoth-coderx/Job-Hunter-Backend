import { getAppConfig } from '../../config/config.service';
import { logger } from '../../../utils/logger';
import { claudeProvider } from './claude.provider';
import { geminiProvider } from './gemini.provider';
import {
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
  AiProviderQuotaError,
} from './types';

export { AiProviderQuotaError } from './types';
export type { AiTier, AiGenerateOptions, AiGenerateResult } from './types';

/**
 * Resolve the active provider per-request so admin changes to
 * `AI_PROVIDER` propagate without a process restart. `claudeProvider`
 * and `geminiProvider` both expose `enabled` as a getter, so the
 * lookups here cost a single Map.get each.
 */
const pickProvider = (): AiProvider => {
  const preferred = getAppConfig('AI_PROVIDER') ?? 'gemini';
  if (preferred === 'claude' && claudeProvider.enabled) return claudeProvider;
  if (preferred === 'gemini' && geminiProvider.enabled) return geminiProvider;
  // Configured provider has no key — fall back to whichever has a key set.
  if (geminiProvider.enabled) return geminiProvider;
  if (claudeProvider.enabled) return claudeProvider;
  // Returned to callers; .generate() throws clearly when invoked.
  return geminiProvider;
};

export const isAiEnabled = (): boolean => geminiProvider.enabled || claudeProvider.enabled;

/**
 * Generate text. Thin pass-through to the active provider.
 */
export const generate = (opts: AiGenerateOptions): Promise<AiGenerateResult> =>
  pickProvider().generate(opts);

/**
 * Generate JSON and parse. Strips fences if the provider added any.
 * Returns null on parse failure so callers can fall back gracefully
 * instead of bubbling SyntaxError to the request.
 */
export const generateJson = async <T>(opts: AiGenerateOptions): Promise<T | null> => {
  try {
    const res = await pickProvider().generate({ ...opts, json: true });
    const cleaned = res.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(cleaned) as T;
  } catch (err) {
    if (err instanceof AiProviderQuotaError) throw err;
    if (err instanceof SyntaxError) {
      logger.warn(`AI JSON parse failed: ${err.message}`);
      return null;
    }
    throw err;
  }
};
