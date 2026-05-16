import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Otp, OtpChannel, OtpPurpose } from '../../models/Otp';
import { ApiError } from '../../utils/ApiError';
import { sendEmail } from '../notification/email.service';
import { sendOtpSms } from '../notification/sms.service';
import { logger } from '../../utils/logger';
import mongoose from 'mongoose';

const OTP_TTL_MS = 10 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;

// 6-digit numeric code; padded so 000000-009999 stay 6 chars.
const generateCode = (): string => {
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
};

interface IssueOtpInput {
  identifier: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  userId?: string | mongoose.Types.ObjectId;
  ip?: string;
}

export const issueOtp = async (input: IssueOtpInput): Promise<{ code: string }> => {
  const ident = input.identifier.toLowerCase();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const lastMinute = new Date(Date.now() - SEND_COOLDOWN_MS);

  const recent = await Otp.find({ identifier: ident, purpose: input.purpose, createdAt: { $gte: oneHourAgo } });
  if (recent.length >= MAX_SENDS_PER_HOUR) {
    throw new ApiError(429, 'Too many OTP requests. Try again later.');
  }
  if (recent.some((r) => r.createdAt > lastMinute)) {
    throw new ApiError(429, 'OTP already sent. Please wait a minute before retrying.');
  }

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  await Otp.create({
    user: input.userId
      ? typeof input.userId === 'string'
        ? new mongoose.Types.ObjectId(input.userId)
        : input.userId
      : undefined,
    identifier: ident,
    channel: input.channel,
    purpose: input.purpose,
    codeHash,
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    ip: input.ip,
  });

  if (input.channel === 'email') {
    await sendEmail({
      to: ident,
      subject: 'Your Job Hunter verification code',
      text: `Your verification code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
      html: `<div style="font-family:system-ui;font-size:15px">Your verification code is <b style="font-size:22px;letter-spacing:4px">${code}</b><br/>It expires in 10 minutes.<br/>If you didn't request this, ignore this email.</div>`,
    }).catch((e) => logger.warn(`[otp] email send failed: ${e.message}`));
  } else if (input.channel === 'phone') {
    // MSG91 (or whatever provider AppConfig points at). Falls back to a
    // no-op when the gateway isn't configured — the persisted code can
    // still be verified, useful for dev environments and the QA
    // bypass-OTP backdoor (admin can read the code via the OTP
    // controller in non-prod builds).
    sendOtpSms(ident, code).catch((e) =>
      logger.warn(`[otp] sms send failed: ${e.message}`),
    );
  }

  return { code };
};

interface VerifyOtpInput {
  identifier: string;
  purpose: OtpPurpose;
  code: string;
}

export const verifyOtp = async (input: VerifyOtpInput): Promise<{ ok: true; userId?: mongoose.Types.ObjectId }> => {
  const ident = input.identifier.toLowerCase();
  const record = await Otp.findOne({
    identifier: ident,
    purpose: input.purpose,
    consumedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  })
    .select('+codeHash')
    .sort({ createdAt: -1 });

  if (!record) throw new ApiError(400, 'OTP not found or expired. Request a new one.');
  if (record.attempts >= record.maxAttempts) {
    throw new ApiError(429, 'Too many attempts. Request a new OTP.');
  }

  const matches = await bcrypt.compare(input.code, record.codeHash);
  if (!matches) {
    record.attempts += 1;
    await record.save();
    throw new ApiError(400, 'Incorrect code.');
  }

  record.consumedAt = new Date();
  await record.save();
  return { ok: true, userId: record.user };
};
