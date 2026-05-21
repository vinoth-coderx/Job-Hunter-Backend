/**
 * Unified AI provider interface. Every service in services/ai/* talks to
 * this surface, never directly to Gemini or Anthropic SDKs. To swap
 * providers, change AI_PROVIDER in env — no service code changes.
 *
 * Two model tiers exposed:
 *   - "lite"  → cheap/fast, structured extraction (resume parse, lists)
 *   - "smart" → reasoning, chat, generation
 *
 * Provider implementations map these tiers to concrete model IDs in
 * config/constants.ts (GEMINI_MODEL_*, CLAUDE_MODEL_*).
 */

export type AiTier = 'lite' | 'smart';

export interface AiGenerateOptions {
  tier: AiTier;
  system: string;
  user: string;
  // Force structured JSON output. Provider enables native JSON mode where
  // available (Gemini responseMimeType, Claude tool-use coercion fallback).
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface AiGenerateResult {
  text: string;
  // Best-effort token usage if the SDK exposes it; used by quota/observability.
  inputTokens?: number;
  outputTokens?: number;
}

export interface AiProvider {
  name: 'gemini' | 'groq';
  enabled: boolean;
  generate(opts: AiGenerateOptions): Promise<AiGenerateResult>;
}

// Thrown by providers when their underlying SDK rejects the request for
// rate-limit or quota reasons. Quota service catches this to surface a
// clean error to controllers.
export class AiProviderQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiProviderQuotaError';
  }
}

/**
 * Thrown when the provider rejects the request for authentication
 * reasons (HTTP 401 / 403 — invalid, expired or revoked API key). The
 * provider chain in `generate()` treats this the same as a quota error
 * and falls through to the next configured provider, because a bad key
 * means the provider is functionally unusable until an admin rotates it.
 */
export class AiProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiProviderAuthError';
  }
}
