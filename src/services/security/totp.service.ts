import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from '../../utils/crypto';
import { User } from '../../models/User';
import { ApiError } from '../../utils/ApiError';
import mongoose from 'mongoose';

// Minimal RFC 6238 TOTP — Base32 secret, 30s window, 6 digits, SHA-1
// (same defaults as Google Authenticator / Authy). Implemented inline
// to avoid pulling in otplib for what amounts to ~50 lines of code.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Encode = (buf: Buffer): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

const base32Decode = (input: string): Buffer => {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

const generateSecret = (): string => base32Encode(crypto.randomBytes(20));

const hotp = (secret: Buffer, counter: bigint): string => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
};

export const verifyTotp = (token: string, base32Secret: string, windowSteps = 1): boolean => {
  const secret = base32Decode(base32Secret);
  const step = BigInt(Math.floor(Date.now() / 30_000));
  for (let i = -windowSteps; i <= windowSteps; i++) {
    if (hotp(secret, step + BigInt(i)) === token) return true;
  }
  return false;
};

export const provisioningUri = (account: string, secret: string, issuer = 'Job Hunter'): string => {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
};

// ─────────────────────────────────────────────────────────────────────────
// User-facing API used by /auth/2fa/* routes
// ─────────────────────────────────────────────────────────────────────────

export interface EnrollResult {
  secret: string;
  uri: string;
}

export const startEnrollment = async (
  userId: string | mongoose.Types.ObjectId,
): Promise<EnrollResult> => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found');
  if (user.twoFactor?.enabled) throw new ApiError(400, '2FA already enabled');

  const secret = generateSecret();
  // We persist the encrypted secret immediately so a half-finished
  // enrollment can be resumed; `enabled` only flips on first verify.
  user.twoFactor = {
    enabled: false,
    method: 'totp',
    secretEnc: encrypt(secret),
    backupCodes: [],
    enrolledAt: undefined,
    lastVerifiedAt: undefined,
  };
  await user.save();
  return { secret, uri: provisioningUri(user.email, secret) };
};

const generateBackupCodes = (count = 10): string[] => {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(5).toString('hex'));
  }
  return codes;
};

export const completeEnrollment = async (
  userId: string | mongoose.Types.ObjectId,
  token: string,
): Promise<{ backupCodes: string[] }> => {
  const user = await User.findById(userId).select('+twoFactor.secretEnc');
  if (!user) throw new ApiError(404, 'User not found');
  if (!user.twoFactor?.secretEnc) throw new ApiError(400, '2FA enrollment not started');
  const secret = decrypt(user.twoFactor.secretEnc);
  if (!verifyTotp(token, secret)) throw new ApiError(400, 'Incorrect code');

  const plain = generateBackupCodes();
  const hashed = await Promise.all(plain.map((c) => bcrypt.hash(c, 10)));
  user.twoFactor.enabled = true;
  user.twoFactor.backupCodes = hashed;
  user.twoFactor.enrolledAt = new Date();
  user.twoFactor.lastVerifiedAt = new Date();
  await user.save();
  return { backupCodes: plain };
};

export const verifyLoginToken = async (
  userId: string | mongoose.Types.ObjectId,
  token: string,
): Promise<boolean> => {
  const user = await User.findById(userId).select('+twoFactor.secretEnc +twoFactor.backupCodes');
  if (!user || !user.twoFactor?.enabled || !user.twoFactor.secretEnc) return false;
  const secret = decrypt(user.twoFactor.secretEnc);
  if (verifyTotp(token, secret)) {
    user.twoFactor.lastVerifiedAt = new Date();
    await user.save();
    return true;
  }
  // Backup code path. Match-and-burn (remove the consumed hash).
  for (let i = 0; i < user.twoFactor.backupCodes.length; i++) {
    if (await bcrypt.compare(token, user.twoFactor.backupCodes[i])) {
      user.twoFactor.backupCodes.splice(i, 1);
      user.twoFactor.lastVerifiedAt = new Date();
      await user.save();
      return true;
    }
  }
  return false;
};

export const disable2fa = async (userId: string | mongoose.Types.ObjectId): Promise<void> => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'User not found');
  user.twoFactor = {
    enabled: false,
    method: 'totp',
    secretEnc: undefined,
    backupCodes: [],
    enrolledAt: undefined,
    lastVerifiedAt: undefined,
  };
  await user.save();
};
