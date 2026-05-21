import { getAppConfig } from '../../config/config.service';
import { logger } from '../../../utils/logger';
import { geminiProvider } from './gemini.provider';
import { groqProvider } from './groq.provider';
import { recordAiUsage } from '../usageLog.service';
import {
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
  AiProviderAuthError,
  AiProviderQuotaError,
} from './types';

export { AiProviderAuthError, AiProviderQuotaError } from './types';
export type { AiTier, AiGenerateOptions, AiGenerateResult } from './types';

/**
 * Optional context every caller can attach to a generate() call so the
 * usage-log row is tagged with the originating feature + user. Untagged
 * calls still log, just under feature='unknown' — but services should
 * tag so the admin analytics page is useful.
 */
export interface AiCallContext {
  userId?: string;
  feature: string;
}

export type AiProviderName = 'gemini' | 'groq';

/**
 * Build the provider chain for a single generate() call:
 * preferred (or AI_PROVIDER from config) first, then the other in a
 * fixed order. Only enabled providers (key configured) are returned —
 * disabled ones are skipped, not surfaced as failures.
 *
 * The chain is consumed by `generate()`; the first provider answers the
 * call, and any AiProviderQuotaError falls through to the next link
 * automatically. Non-quota errors don't trigger fallback because they
 * usually mean the caller's prompt is bad — retrying won't help.
 */
const ALL_PROVIDER_NAMES: AiProviderName[] = ['gemini', 'groq'];

const providerByName = (name: AiProviderName): AiProvider => {
  if (name === 'groq') return groqProvider;
  return geminiProvider;
};

const buildProviderChain = (preferred?: AiProviderName): AiProvider[] => {
  const want =
    preferred ??
    (getAppConfig('AI_PROVIDER') as AiProviderName | null) ??
    'gemini';
  // Preferred first, then the rest in `ALL_PROVIDER_NAMES` order — dedupe
  // and keep only the providers that currently have a key configured.
  const ordered = [want, ...ALL_PROVIDER_NAMES.filter((n) => n !== want)];
  const seen = new Set<string>();
  const chain: AiProvider[] = [];
  for (const name of ordered) {
    if (seen.has(name)) continue;
    seen.add(name);
    const p = providerByName(name);
    if (p.enabled) chain.push(p);
  }
  return chain;
};

export const isAiEnabled = (): boolean =>
  geminiProvider.enabled || groqProvider.enabled;

export const isProviderEnabled = (name: AiProviderName): boolean => {
  if (name === 'gemini') return geminiProvider.enabled;
  return groqProvider.enabled;
};

/**
 * Generate text. Records one AiUsageLog row per call attempt
 * (success or failure). `opts.provider` lets callers force a specific
 * lane (e.g. moderation uses 'groq' first, then escalates to 'gemini').
 *
 * Fallback: if the chosen provider throws an `AiProviderQuotaError`,
 * the next provider in the chain (preferred → others) is tried with the
 * same prompt. Non-quota errors short-circuit because they're almost
 * always caller-side (bad prompt, validation) and retrying won't help.
 */
export const generate = async (
  opts: AiGenerateOptions & { provider?: AiProviderName },
  ctx?: AiCallContext,
): Promise<AiGenerateResult> => {
  const chain = buildProviderChain(opts.provider);
  if (chain.length === 0) {
    // No provider has a key configured. Call gemini so its existing
    // "provider disabled" error bubbles up with a clear message.
    return geminiProvider.generate(opts);
  }
  let lastFallbackError: Error | null = null;
  for (const provider of chain) {
    const startedAt = Date.now();
    try {
      const result = await provider.generate(opts);
      recordAiUsage({
        userId: ctx?.userId,
        feature: ctx?.feature ?? 'unknown',
        provider: provider.name,
        tier: opts.tier,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Date.now() - startedAt,
        success: true,
      });
      return result;
    } catch (err) {
      const isQuota = err instanceof AiProviderQuotaError;
      const isAuth = err instanceof AiProviderAuthError;
      const isFallbackable = isQuota || isAuth;
      const errorCode = isQuota
        ? 'quota'
        : isAuth
          ? 'auth'
          : (err as Error)?.name ?? 'error';
      recordAiUsage({
        userId: ctx?.userId,
        feature: ctx?.feature ?? 'unknown',
        provider: provider.name,
        tier: opts.tier,
        latencyMs: Date.now() - startedAt,
        success: false,
        errorCode,
      });
      if (!isFallbackable) throw err;
      lastFallbackError = err as Error;
      // Try the next provider in the chain on quota OR auth (bad key)
      // errors — both render this provider unusable for the request.
    }
  }
  // Every provider in the chain returned a quota or auth error.
  throw (
    lastFallbackError ??
    new AiProviderQuotaError('All AI providers unavailable (quota or auth)')
  );
};

/**
 * Generate JSON and parse. Strips fences if the provider added any.
 * Returns null on parse failure so callers can fall back gracefully
 * instead of bubbling SyntaxError to the request.
 */
export const generateJson = async <T>(
  opts: AiGenerateOptions & { provider?: AiProviderName },
  ctx?: AiCallContext,
): Promise<T | null> => {
  try {
    const res = await generate({ ...opts, json: true }, ctx);
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

/**
 * Convenience: log a cache hit so the admin dashboard can show the
 * "cache savings" ratio. Call this from a service when it serves a
 * cached response without invoking the provider.
 */
export const recordCacheHit = (ctx: AiCallContext, tier: 'lite' | 'smart' = 'lite'): void => {
  recordAiUsage({
    userId: ctx.userId,
    feature: ctx.feature,
    provider: 'gemini',
    tier,
    latencyMs: 0,
    success: true,
    cacheHit: true,
  });
};
