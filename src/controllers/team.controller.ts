import { Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { HirerProfile, TeamMemberRole } from '../models/HirerProfile';
import { TeamInvite, TeamRole } from '../models/TeamInvite';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { sendTeamInviteEmail } from '../services/notification/email.service';
import { logger } from '../utils/logger';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

export const inviteSchema = z.object({
  body: z.object({
    email: z.string().email().max(200),
    role: z.enum(['admin', 'recruiter', 'interviewer']),
  }),
});

export const acceptSchema = z.object({
  body: z.object({
    token: z.string().min(32).max(128),
  }),
});

export const updateRoleSchema = z.object({
  body: z.object({
    role: z.enum(['admin', 'recruiter', 'interviewer']),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const requireOwnedHirerProfile = async (userId: string) => {
  const profile = await HirerProfile.findOne({ user: userId });
  if (!profile) throw ApiError.forbidden('Set up a company profile first');
  return profile;
};

const requireAdminOnHirer = async (userId: string) => {
  // Only the owner OR an admin team member can manage the team.
  const profile = await HirerProfile.findOne({
    $or: [
      { user: userId },
      {
        teamMembers: {
          $elemMatch: {
            user: new mongoose.Types.ObjectId(userId),
            role: 'admin',
            isActive: true,
          },
        },
      },
    ],
  });
  if (!profile) throw ApiError.forbidden('Admin access required');
  return profile;
};

// ─────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────

export const inviteTeamMember = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireAdminOnHirer(req.user.id);
  const { email, role } = req.body as z.infer<typeof inviteSchema>['body'];

  // Don't invite an existing member.
  const existingUser = await User.findOne({ email: email.toLowerCase() }).select('_id').lean();
  if (existingUser) {
    const already = profile.teamMembers.some(
      (m) => m.user.toString() === existingUser._id.toString() && m.isActive,
    );
    if (already) throw ApiError.conflict('Already a team member');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14d

  // Upsert: re-inviting the same email replaces the prior pending invite.
  const invite = await TeamInvite.findOneAndUpdate(
    {
      hirerProfile: profile._id,
      email: email.toLowerCase(),
      status: 'pending',
    },
    {
      $set: {
        hirerProfile: profile._id,
        invitedBy: req.user._id,
        email: email.toLowerCase(),
        role,
        token,
        status: 'pending',
        expiresAt,
      },
    },
    { upsert: true, new: true },
  );

  // Fire-and-forget: send the invite email if SMTP is configured. The
  // dialog still surfaces the token so admins can DM it as a fallback.
  const inviter = await User.findById(req.user._id)
    .select('email profile.fullName')
    .lean();
  void sendTeamInviteEmail({
    toEmail: invite.email,
    companyName: profile.companyName,
    inviterName: inviter?.profile?.fullName || inviter?.email,
    role: invite.role,
    token: invite.token,
    expiresAt: invite.expiresAt,
  }).catch((err) =>
    logger.warn(`team invite email dispatch failed: ${(err as Error).message}`),
  );

  res.status(201).json({
    success: true,
    data: {
      id: invite._id.toString(),
      email: invite.email,
      role: invite.role,
      token: invite.token,
      expiresAt: invite.expiresAt,
    },
  });
});

export const listTeam = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireOwnedHirerProfile(req.user.id);

  // Hydrate team members with profile + email so the UI doesn't have to
  // round-trip per row.
  const populated = await HirerProfile.findById(profile._id)
    .populate({
      path: 'teamMembers.user',
      select: 'email profile.fullName profile.avatar',
    })
    .lean();
  const members = (populated?.teamMembers ?? [])
    .filter((m) => m.isActive)
    .map((m) => {
      const u = m.user as unknown as
        | { _id: mongoose.Types.ObjectId; email: string; profile?: { fullName?: string; avatar?: string } }
        | null;
      return {
        userId: u?._id.toString() ?? null,
        email: u?.email ?? null,
        fullName: u?.profile?.fullName ?? null,
        avatar: u?.profile?.avatar ?? null,
        role: m.role,
        addedAt: m.addedAt,
      };
    });

  const invites = await TeamInvite.find({
    hirerProfile: profile._id,
    status: 'pending',
  })
    .sort({ createdAt: -1 })
    .select('email role expiresAt createdAt')
    .lean();

  res.json({
    success: true,
    data: {
      ownerUserId: profile.user.toString(),
      members,
      pendingInvites: invites.map((i) => ({
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        invitedAt: i.createdAt,
      })),
    },
  });
});

export const acceptInvite = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { token } = req.body as z.infer<typeof acceptSchema>['body'];

  const invite = await TeamInvite.findOne({ token, status: 'pending' });
  if (!invite) throw ApiError.notFound('Invalid or expired invite');
  if (invite.expiresAt < new Date()) {
    invite.status = 'expired';
    await invite.save();
    throw ApiError.badRequest('Invite has expired');
  }

  const user = await User.findById(req.user._id).select('email').lean();
  if (!user) throw ApiError.notFound('User not found');
  // Soft email check — case-insensitive — to prevent invite stealing.
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw ApiError.forbidden('This invite was sent to a different email');
  }

  const profile = await HirerProfile.findById(invite.hirerProfile);
  if (!profile) throw ApiError.notFound('Company no longer exists');

  // Add or reactivate the team member.
  const existing = profile.teamMembers.find(
    (m) => m.user.toString() === req.user!._id!.toString(),
  );
  if (existing) {
    existing.role = invite.role as TeamMemberRole;
    existing.isActive = true;
  } else {
    profile.teamMembers.push({
      user: req.user._id! as mongoose.Types.ObjectId,
      role: invite.role as TeamMemberRole,
      addedAt: new Date(),
      isActive: true,
    });
  }
  await profile.save();

  invite.status = 'accepted';
  invite.acceptedAt = new Date();
  invite.acceptedBy = req.user._id! as mongoose.Types.ObjectId;
  await invite.save();

  res.json({
    success: true,
    data: {
      hirerProfileId: profile._id.toString(),
      companyName: profile.companyName,
      role: invite.role,
    },
  });
});

export const removeMember = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireAdminOnHirer(req.user.id);
  const userId = String(req.params.userId);
  if (!isObjectId(userId)) throw ApiError.badRequest('Invalid user id');

  if (userId === profile.user.toString()) {
    throw ApiError.forbidden('The owner cannot be removed from the team');
  }

  const before = profile.teamMembers.length;
  profile.teamMembers = profile.teamMembers.filter(
    (m) => m.user.toString() !== userId,
  );
  if (profile.teamMembers.length === before) {
    throw ApiError.notFound('Member not found');
  }
  await profile.save();
  res.json({ success: true, message: 'Removed' });
});

export const updateMemberRole = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireAdminOnHirer(req.user.id);
  const userId = String(req.params.userId);
  if (!isObjectId(userId)) throw ApiError.badRequest('Invalid user id');
  const { role } = req.body as { role: TeamRole };

  if (userId === profile.user.toString()) {
    throw ApiError.forbidden('The owner\'s role is fixed');
  }

  const member = profile.teamMembers.find((m) => m.user.toString() === userId);
  if (!member) throw ApiError.notFound('Member not found');
  member.role = role as TeamMemberRole;
  await profile.save();
  res.json({ success: true, data: { userId, role } });
});

export const revokeInvite = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireAdminOnHirer(req.user.id);
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid invite id');

  const invite = await TeamInvite.findOneAndUpdate(
    { _id: id, hirerProfile: profile._id, status: 'pending' },
    { $set: { status: 'revoked' } },
    { new: true },
  );
  if (!invite) throw ApiError.notFound('Pending invite not found');
  res.json({ success: true });
});
