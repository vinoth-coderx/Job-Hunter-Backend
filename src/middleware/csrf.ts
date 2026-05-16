import { Request, Response, NextFunction } from 'express';
import { hmacSign, constantTimeEqual, randomToken } from '../utils/crypto';
import { ApiError } from '../utils/ApiError';

// Stateless double-submit CSRF guard. The server issues a token bound
// to the session via HMAC; the client mirrors it in the X-CSRF-Token
// header. Mobile clients authenticate purely with bearer JWTs over
// HTTPS (no cookies, no implicit credentials) so CSRF doesn't apply
// there — this guard only fires when the request carries cookies.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_COOKIE = 'jh_csrf';

const buildToken = (secret: string): string => {
  const nonce = randomToken(16);
  const sig = hmacSign(nonce, secret).slice(0, 32);
  return `${nonce}.${sig}`;
};

const verifyToken = (token: string, secret: string): boolean => {
  const [nonce, sig] = token.split('.');
  if (!nonce || !sig) return false;
  const expected = hmacSign(nonce, secret).slice(0, 32);
  return constantTimeEqual(sig, expected);
};

export const issueCsrfToken = (req: Request, res: Response, next: NextFunction): void => {
  const secret = (req.signedCookies?.[`${TOKEN_COOKIE}_s`] as string | undefined) ?? randomToken(24);
  if (!req.signedCookies?.[`${TOKEN_COOKIE}_s`]) {
    res.cookie(`${TOKEN_COOKIE}_s`, secret, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      signed: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
  const token = buildToken(secret);
  res.setHeader('X-CSRF-Token', token);
  next();
};

export const requireCsrf = (req: Request, _res: Response, next: NextFunction): void => {
  if (SAFE_METHODS.has(req.method)) return next();
  // Pure bearer-token clients (mobile app + admin SPA) don't carry
  // browser cookies, so CSRF is a no-op for them. We only enforce
  // when a session cookie is present.
  if (!req.headers.cookie) return next();
  const secret = req.signedCookies?.[`${TOKEN_COOKIE}_s`] as string | undefined;
  const token = (req.headers['x-csrf-token'] as string) || (req.body?._csrf as string);
  if (!secret || !token || !verifyToken(token, secret)) {
    return next(new ApiError(403, 'Invalid CSRF token'));
  }
  next();
};
