import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { createHash } from 'crypto';
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } from '../config/constants';

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

export const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  // Health pings (uptime monitors, Render's keep-alive, the app's first
  // launch ping) aren't user actions — letting them count towards the
  // bucket would push real users into 429s on slow startups.
  skip: (req) => req.path === '/' || req.path.endsWith('/health'),
  keyGenerator: tokenAwareKey,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

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
