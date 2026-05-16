import { Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { Verification } from '../models/Verification';
import { HirerProfile } from '../models/HirerProfile';
import { issueOtp, verifyOtp } from '../services/security/otp.service';
import { writeAudit } from '../services/security/audit.service';
import { recomputeHirerTrust } from '../services/security/trustScore.service';

const requireHirer = async (req: AuthRequest) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await HirerProfile.findOne({ user: req.user._id });
  if (!profile) throw new ApiError(404, 'Hirer profile not found');
  return profile;
};

// ─── GST ──────────────────────────────────────────────────────────────────

export const submitGstSchema = z.object({
  body: z.object({
    gstNumber: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Invalid GST number'),
  }),
});

export const submitGst = asyncHandler(async (req: AuthRequest, res: Response) => {
  const profile = await requireHirer(req);
  const v = await Verification.create({
    hirer: req.user!.id,
    company: profile._id,
    channel: 'gst',
    payload: { gstNumber: req.body.gstNumber },
  });
  profile.verification.gstNumber = req.body.gstNumber;
  await profile.save();
  await writeAudit({
    actor: { id: req.user!.id, email: req.user!.email },
    actorType: 'hirer',
    category: 'verification',
    action: 'verification:gst:submitted',
    target: { type: 'Verification', id: v._id },
    req,
  });
  res.status(201).json({ success: true, data: v });
});

// ─── Domain email (auto-verified via OTP to the company domain) ──────────

export const submitDomainEmailSchema = z.object({
  body: z.object({
    email: z.string().email().max(200),
  }),
});

export const submitDomainEmail = asyncHandler(async (req: AuthRequest, res: Response) => {
  const profile = await requireHirer(req);
  const email = req.body.email.toLowerCase();
  if (profile.website) {
    const domain = profile.website.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
    if (!email.endsWith('@' + domain)) {
      throw new ApiError(400, `Email must match your company website domain (${domain})`);
    }
  }
  await Verification.create({
    hirer: req.user!.id,
    company: profile._id,
    channel: 'domain_email',
    payload: { domainEmail: email },
  });
  await issueOtp({
    identifier: email,
    channel: 'email',
    purpose: 'sensitive_action',
    userId: req.user!.id,
    ip: req.ip,
  });
  res.json({ success: true, message: 'OTP sent to your company email' });
});

export const confirmDomainEmailSchema = z.object({
  body: z.object({
    email: z.string().email(),
    code: z.string().length(6),
  }),
});

export const confirmDomainEmail = asyncHandler(async (req: AuthRequest, res: Response) => {
  const profile = await requireHirer(req);
  await verifyOtp({ identifier: req.body.email, code: req.body.code, purpose: 'sensitive_action' });
  await Verification.updateMany(
    { hirer: req.user!.id, company: profile._id, channel: 'domain_email', status: 'pending' },
    {
      $set: {
        status: 'auto_verified',
        'payload.domainEmailVerifiedAt': new Date(),
        reviewedAt: new Date(),
      },
    },
  );
  profile.verification.levels.domainEmail = true;
  profile.verification.officialDomainEmail = req.body.email.toLowerCase();
  profile.verification.isVerified = Object.values(profile.verification.levels).some(Boolean);
  await profile.save();
  await recomputeHirerTrust(req.user!.id);
  await writeAudit({
    actor: { id: req.user!.id, email: req.user!.email },
    actorType: 'hirer',
    category: 'verification',
    action: 'verification:domain_email:approved',
    req,
  });
  res.json({ success: true });
});

// ─── Website (TXT-style file token verification) ──────────────────────────

export const submitWebsiteSchema = z.object({
  body: z.object({ website: z.string().url().max(500) }),
});

export const submitWebsite = asyncHandler(async (req: AuthRequest, res: Response) => {
  const profile = await requireHirer(req);
  const token = `jobhunter-verify-${new mongoose.Types.ObjectId().toHexString()}`;
  await Verification.create({
    hirer: req.user!.id,
    company: profile._id,
    channel: 'website',
    payload: { website: req.body.website, websiteFileToken: token },
  });
  res.status(201).json({
    success: true,
    data: {
      website: req.body.website,
      token,
      instructions: `Host a file at ${req.body.website.replace(/\/$/, '')}/.well-known/jobhunter-verification.txt whose body is the token above, then call POST /api/v1/hirer/verification/website/confirm.`,
    },
  });
});

// ─── LinkedIn page (manual review) ────────────────────────────────────────

export const submitLinkedinSchema = z.object({
  body: z.object({ linkedinUrl: z.string().url().max(500) }),
});

export const submitLinkedin = asyncHandler(async (req: AuthRequest, res: Response) => {
  const profile = await requireHirer(req);
  const v = await Verification.create({
    hirer: req.user!.id,
    company: profile._id,
    channel: 'linkedin',
    payload: { linkedinUrl: req.body.linkedinUrl },
  });
  profile.verification.linkedinPageUrl = req.body.linkedinUrl;
  await profile.save();
  res.status(201).json({ success: true, data: v });
});

// ─── List my verifications + status pill ──────────────────────────────────

export const myVerificationStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  const profile = await requireHirer(req);
  const submissions = await Verification.find({ hirer: req.user!.id })
    .sort({ createdAt: -1 })
    .lean();
  res.json({
    success: true,
    data: {
      profile: {
        isVerified: profile.verification.isVerified,
        levels: profile.verification.levels,
        approvalStatus: profile.approvalStatus,
        trustScore: profile.trustScore,
      },
      submissions,
    },
  });
});
