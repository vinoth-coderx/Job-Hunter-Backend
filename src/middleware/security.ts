import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { redis } from '../config/redis';
import { constantTimeEqual, hash, hmacSign } from '../utils/crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const FAILED_LOGIN_LIMIT = 6;
const FAILED_LOGIN_WINDOW_SEC = 15 * 60;
const LOCKOUT_SEC = 30 * 60;

export const recordFailedLogin = async (key: string): Promise<{ locked: boolean; remaining: number }> => {
  const k = `lockout:${hash(key)}`;
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, FAILED_LOGIN_WINDOW_SEC);
  if (count >= FAILED_LOGIN_LIMIT) {
    await redis.expire(k, LOCKOUT_SEC);
    return { locked: true, remaining: 0 };
  }
  return { locked: false, remaining: FAILED_LOGIN_LIMIT - count };
};

export const isLockedOut = async (key: string): Promise<boolean> => {
  const k = `lockout:${hash(key)}`;
  const count = parseInt((await redis.get(k)) || '0', 10);
  return count >= FAILED_LOGIN_LIMIT;
};

export const clearFailedLogins = async (key: string): Promise<void> => {
  await redis.del(`lockout:${hash(key)}`);
};

export const requireSignedRequest = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (env.NODE_ENV === 'development' && !req.headers['x-signature']) return next();

    const signature = req.headers['x-signature'] as string | undefined;
    const timestamp = req.headers['x-timestamp'] as string | undefined;
    const nonce = req.headers['x-nonce'] as string | undefined;

    if (!signature || !timestamp || !nonce) {
      throw ApiError.unauthorized('Missing signature headers');
    }

    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      throw ApiError.unauthorized('Stale or invalid timestamp');
    }

    const nonceKey = `nonce:${nonce}`;
    const seen = await redis.set(nonceKey, '1', 'EX', 600, 'NX');
    if (!seen) throw ApiError.unauthorized('Nonce reuse detected');

    const body = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '';
    const payload = `${req.method}\n${req.originalUrl}\n${timestamp}\n${nonce}\n${body}`;
    const expected = hmacSign(payload);

    if (!constantTimeEqual(signature, expected)) {
      throw ApiError.unauthorized('Invalid signature');
    }

    next();
  } catch (err) {
    next(err);
  }
};

export const securityHeaders = (_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
  next();
};

export const slowDownAfterFailures = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const k = `slowdown:${hash(ip)}`;
    const count = parseInt((await redis.get(k)) || '0', 10);
    if (count > 3) {
      const delayMs = Math.min(2000, count * 250);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    next();
  } catch (err) {
    logger.warn('slowDown middleware error', err);
    next();
  }
};

// Routes that legitimately accept HTML, script-like or operator-like text
// in their request bodies (e.g. admin uploading a resume template HTML
// file). Body inspection is skipped for these paths — the URL itself is
// still scanned, and they remain auth-gated by their own router middleware.
const BODY_SCAN_BYPASS_PREFIXES = [
  '/api/v1/admin/resume-templates',
];

export const detectSuspiciousActivity = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const ua = req.headers['user-agent'] || '';
  const url = req.originalUrl;
  const decodedUrl = decodeURIComponent(url);

  const suspicious = [
    /\.\.\//,
    /(union\s+select|or\s+1=1|--\s|\/\*)/i,
    /<script\b/i,
    /(eval|exec|system)\s*\(/i,
    /\$where|\$ne|\$gt|\$regex/,
  ];

  // Always scan the URL itself (path/query). Scan the body only for
  // routes that don't legitimately carry HTML or code-like payloads.
  const scanBody = !BODY_SCAN_BYPASS_PREFIXES.some((p) => decodedUrl.startsWith(p));
  const body = scanBody ? JSON.stringify(req.body || {}) : '';

  if (
    suspicious.some(
      (re) => re.test(decodedUrl) || (scanBody && re.test(body)),
    )
  ) {
    logger.warn(`Suspicious request blocked from ${req.ip} ua="${ua}" url="${url}"`);
    return next(ApiError.badRequest('Request blocked'));
  }

  next();
};
