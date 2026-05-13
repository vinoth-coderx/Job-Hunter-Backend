import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { env } from '../config/env';
import { ApiError } from './ApiError';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard nonce length
const TAG_LENGTH = 16;

const masterKey = (): Buffer => {
  if (!env.CRYPTO_MASTER_KEY) {
    throw ApiError.internal(
      'CRYPTO_MASTER_KEY is not configured. Set a 32-byte hex string in .env to manage AI keys.',
    );
  }
  return Buffer.from(env.CRYPTO_MASTER_KEY, 'hex');
};

/**
 * Encrypts plaintext (e.g. an AI provider API key) under [CRYPTO_MASTER_KEY]
 * using AES-256-GCM. Output is a self-contained `iv:tag:cipher` string with
 * each segment hex-encoded — no separate IV column needed in storage.
 *
 * The IV is random per call so two identical keys never produce the same
 * ciphertext at rest.
 */
export const encryptSecret = (plaintext: string): string => {
  const key = masterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
};

/**
 * Reverses [encryptSecret]. Throws if the master key has changed or the
 * ciphertext was tampered with (the GCM auth tag catches both).
 */
export const decryptSecret = (encoded: string): string => {
  const key = masterKey();
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw ApiError.internal('Corrupted ciphertext (wrong segment count)');
  }
  const [ivHex, tagHex, cipherHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw ApiError.internal('Corrupted ciphertext (bad iv/tag length)');
  }
  const ciphertext = Buffer.from(cipherHex, 'hex');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
};

/**
 * Returns a UI-safe preview of a stored API key. Shows the first 8 and
 * last 4 characters with the middle obfuscated — enough for an admin
 * to recognise which key they're looking at, never enough to leak it.
 */
export const maskApiKey = (plain: string): string => {
  if (!plain) return '';
  if (plain.length <= 12) return '*'.repeat(plain.length);
  const head = plain.slice(0, 8);
  const tail = plain.slice(-4);
  return `${head}${'*'.repeat(Math.max(4, plain.length - 12))}${tail}`;
};

export const isCryptoConfigured = (): boolean => !!env.CRYPTO_MASTER_KEY;
