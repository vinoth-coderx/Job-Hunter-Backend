import crypto from 'crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY = crypto.createHash('sha256').update(env.JWT_SECRET).digest();

export const encrypt = (plain: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`;
};

export const decrypt = (token: string): string => {
  const [ivB64, encB64, tagB64] = token.split('.');
  if (!ivB64 || !encB64 || !tagB64) throw new Error('Invalid encrypted payload');
  const iv = Buffer.from(ivB64, 'base64url');
  const enc = Buffer.from(encB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
};

export const hmacSign = (data: string, secret: string = env.JWT_SECRET): string => {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
};

export const constantTimeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

export const hash = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex');
