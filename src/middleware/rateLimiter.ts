import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { Request } from 'express';
import { createHash } from 'crypto';
import { getAppConfig } from '../services/config/config.service';

// Default values used when the admin hasn't overridden them in AppConfig
// (or when AppConfig is unreachable at boot). Generous for a multi-screen
// app: a fresh launch easily fires 20-30 requests and the user comfortably
// racks up another 50+ in a few minutes — 600 / 15min ~= 40/min steady
// state, still tight enough to block scraping.
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 600;

const positiveInt = (raw: string | null, fallback: number): number => {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Authenticated users get a per-token bucket so two users sharing the
// same NAT (mobile carrier, office Wi-Fi) don't fight over one IP-based
// quota. Unauthenticated traffic falls back to the request IP. We hash
// the bearer token so a long string isn't held in the limiter store and
// so raw tokens never surface in logs.
const tokenAwareKey = (req: Request): string => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    if (token) {
      return 'tok:' + createHash('sha256').update(token).digest('hex').slice(0, 24);
    }
  }
  return 'ip:' + (req.ip ?? 'unknown');
};

/**
 * Factory so the limiter resolves its window + max from AppConfig at
 * createApp() time — by then `preloadAppConfig()` has populated the
 * cache. A module-level `const` would snapshot the values at import
 * time (before preload), forcing admins back to .env edits + restarts
 * to change limits.
 */
export const createGeneralLimiter = (): RateLimitRequestHandler => {
  const windowMs = positiveInt(
    getAppConfig('RATE_LIMIT_WINDOW_MS'),
    DEFAULT_RATE_LIMIT_WINDOW_MS,
  );
  const max = positiveInt(
    getAppConfig('RATE_LIMIT_MAX_REQUESTS'),
    DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  );
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Health pings (uptime monitors, Render's keep-alive, the app's first
    // launch ping) aren't user actions — letting them count towards the
    // bucket would push real users into 429s on slow startups.
    skip: (req) => req.path === '/' || req.path.endsWith('/health'),
    keyGenerator: tokenAwareKey,
    message: { success: false, message: 'Too many requests. Please try again later.' },
  });
};

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
});

export const scrapeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { success: false, message: 'Scraping rate limit exceeded.' },
});

// AI-search uses Claude Haiku for intent extraction (cached 24h per
// query) plus a Mongo $or fan-out — both cheap individually but
// expensive enough at scale that a runaway client (or a bot) can drain
// the LLM budget fast. Limit to 30 calls / minute per token, which
// comfortably covers human typing bursts (debounce + 600ms = ~1
// req/sec peak) but stops abuse cold.
export const aiSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: tokenAwareKey,
  message: {
    success: false,
    message: 'Too many searches in a row. Take a breath and try again in a minute.',
  },
});
