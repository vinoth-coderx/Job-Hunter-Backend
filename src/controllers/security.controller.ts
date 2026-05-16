import { Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { issueOtp, verifyOtp } from '../services/security/otp.service';
import {
  startEnrollment,
  completeEnrollment,
  verifyLoginToken,
  disable2fa,
} from '../services/security/totp.service';
import {
  listActiveSessions,
  revokeSession,
  revokeAllSessions,
} from '../services/security/session.service';
import { ResumeAccessLog } from '../models/ResumeAccessLog';
import { writeAudit } from '../services/security/audit.service';
import mongoose from 'mongoose';

// ─── OTP ──────────────────────────────────────────────────────────────────

export const sendOtpSchema = z.object({
  body: z.object({
    channel: z.enum(['email', 'phone']),
    purpose: z.enum(['email_verification', 'phone_verification', 'password_reset', 'sensitive_action']),
    identifier: z.string().min(3).max(120),
  }),
});

export const sendOtp = asyncHandler(async (req: AuthRequest, res: Response) => {
  await issueOtp({
    channel: req.body.channel,
    purpose: req.body.purpose,
    identifier: req.body.identifier,
    userId: req.user?.id,
    ip: req.ip,
  });
  res.json({ success: true, message: 'OTP sent' });
});

export const verifyOtpSchema = z.object({
  body: z.object({
    identifier: z.string().min(3).max(120),
    code: z.string().length(6),
    purpose: z.enum(['email_verification', 'phone_verification', 'password_reset', 'sensitive_action']),
  }),
});

export const verifyOtpHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  await verifyOtp({
    identifier: req.body.identifier,
    code: req.body.code,
    purpose: req.body.purpose,
  });
  if (req.user?._id) {
    if (req.body.purpose === 'email_verification') {
      await User.updateOne({ _id: req.user.id }, { $set: { isEmailVerified: true } });
    } else if (req.body.purpose === 'phone_verification') {
      await User.updateOne(
        { _id: req.user.id },
        { $set: { isPhoneVerified: true, 'profile.phone': req.body.identifier } },
      );
    }
  }
  await writeAudit({
    actor: { id: req.user?._id, email: req.user?.email },
    actorType: 'user',
    category: 'auth',
    action: `otp:${req.body.purpose}:verified`,
    req,
  });
  res.json({ success: true });
});

// ─── 2FA TOTP ─────────────────────────────────────────────────────────────

export const start2faEnrollment = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const out = await startEnrollment(req.user.id);
  res.json({ success: true, data: out });
});

export const verify2faSchema = z.object({
  body: z.object({ token: z.string().min(6).max(12) }),
});

export const finish2faEnrollment = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const out = await completeEnrollment(req.user.id, req.body.token);
  await writeAudit({
    actor: { id: req.user.id, email: req.user.email },
    actorType: 'user',
    category: 'auth',
    action: '2fa:enabled',
    req,
  });
  res.json({ success: true, data: out });
});

export const verify2fa = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const ok = await verifyLoginToken(req.user.id, req.body.token);
  if (!ok) throw new ApiError(400, 'Incorrect code');
  res.json({ success: true });
});

export const disable2faHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  await disable2fa(req.user.id);
  await writeAudit({
    actor: { id: req.user.id, email: req.user.email },
    actorType: 'user',
    category: 'auth',
    action: '2fa:disabled',
    req,
  });
  res.json({ success: true });
});

// ─── Sessions / Devices ───────────────────────────────────────────────────

export const listSessions = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const sessions = await listActiveSessions(req.user.id);
  res.json({ success: true, data: sessions });
});

export const revokeSessionHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const sessionId = req.params.id as string;
  await revokeSession(req.user.id, sessionId);
  await writeAudit({
    actor: { id: req.user.id, email: req.user.email },
    actorType: 'user',
    category: 'auth',
    action: 'session:revoked',
    target: { type: 'UserSession', id: sessionId },
    req,
  });
  res.json({ success: true });
});

export const revokeAllSessionsHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  await revokeAllSessions(req.user.id);
  res.json({ success: true });
});

// ─── Privacy ──────────────────────────────────────────────────────────────

export const updatePrivacySchema = z.object({
  body: z.object({
    openToWork: z.boolean().optional(),
    hideFromCurrentEmployer: z.boolean().optional(),
    hidePersonalDetails: z.boolean().optional(),
    hideContactUntilShortlisted: z.boolean().optional(),
    resumeVisibility: z.enum(['public', 'applied_only', 'private']).optional(),
    searchableInResumeDatabase: z.boolean().optional(),
    allowResumeDownload: z.boolean().optional(),
  }),
});

export const updatePrivacy = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (v !== undefined) updates[`privacy.${k}`] = v;
  }
  const user = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true });
  res.json({ success: true, data: user?.privacy });
});

// ─── Resume access log (seeker visibility) ────────────────────────────────

export const listResumeAccessLog = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const logs = await ResumeAccessLog.find({ resumeOwner: req.user.id })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('accessor', 'profile.fullName email')
    .lean();
  res.json({ success: true, data: logs });
});

// ─── Password strength check ─────────────────────────────────────────────

export const checkPasswordStrengthSchema = z.object({
  body: z.object({ password: z.string().min(1).max(200) }),
});

export const checkPasswordStrength = asyncHandler(async (req: AuthRequest, res: Response) => {
  const pwd: string = req.body.password;
  let score = 0;
  if (pwd.length >= 12) score += 25;
  else if (pwd.length >= 8) score += 12;
  if (/[A-Z]/.test(pwd)) score += 15;
  if (/[a-z]/.test(pwd)) score += 10;
  if (/[0-9]/.test(pwd)) score += 15;
  if (/[^A-Za-z0-9]/.test(pwd)) score += 20;
  if (!/(.)\1{2,}/.test(pwd)) score += 5;
  if (!/^(password|qwerty|admin|welcome|letmein)/i.test(pwd)) score += 10;
  const band = score >= 80 ? 'strong' : score >= 55 ? 'good' : score >= 35 ? 'fair' : 'weak';
  res.json({ success: true, data: { score: Math.min(100, score), band } });
});
