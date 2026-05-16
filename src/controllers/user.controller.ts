import { Response } from 'express';
import { z } from 'zod';
import { User } from '../models/User';
import { HirerProfile } from '../models/HirerProfile';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { AuthRequest } from '../types';
import { invalidateProfileOptimizerCache } from '../services/ai/profileOptimizer.service';
import { maybeGrantProfileCompleteBonus } from '../services/coins/coin.service';

export const updateProfileSchema = z.object({
  body: z.object({
    fullName: z.string().min(2).max(100).optional(),
    phone: z.string().optional(),
    headline: z.string().max(200).optional(),
    skills: z.array(z.string()).max(50).optional(),
    experienceYears: z.number().min(0).max(60).optional(),
    preferredRoles: z.array(z.string()).max(20).optional(),
    preferredLocations: z.array(z.string()).max(20).optional(),
    preferredJobTypes: z
      .array(z.enum(['full-time', 'part-time', 'contract', 'internship', 'temporary', 'unknown']))
      .optional(),
    preferredRemote: z.array(z.enum(['remote', 'hybrid', 'onsite', 'unknown'])).optional(),
    expectedSalaryMin: z.number().min(0).optional(),
    resumeUrl: z.string().url().optional(),
    resumeText: z.string().max(20000).optional(),
    avatar: z.string().url().optional(),
  }),
});

const employmentEntrySchema = z.object({
  designation: z.string().max(120).default(''),
  company: z.string().max(120).default(''),
  period: z.string().max(80).default(''),
  current: z.boolean().default(false),
});

const educationEntrySchema = z.object({
  degree: z.string().max(160).default(''),
  institute: z.string().max(220).default(''),
  period: z.string().max(80).default(''),
  type: z.string().max(40).default('Full Time'),
  projects: z.array(z.string().max(160)).max(20).default([]),
});

const itSkillEntrySchema = z.object({
  skill: z.string().max(80).default(''),
  version: z.string().max(20).default('-'),
  lastUsed: z.string().max(20).default(''),
  experience: z.string().max(40).default(''),
});

const projectEntrySchema = z.object({
  title: z.string().max(160).default(''),
  company: z.string().max(120).default(''),
  type: z.string().max(40).default('Full Time'),
  period: z.string().max(80).default(''),
  description: z.string().max(2000).default(''),
});

const languageEntrySchema = z.object({
  language: z.string().max(40).default(''),
  proficiency: z.string().max(40).default('Intermediate'),
  read: z.boolean().default(true),
  write: z.boolean().default(true),
  speak: z.boolean().default(true),
});

const accomplishmentEntrySchema = z.object({
  type: z.string().max(120).default(''),
  label: z.string().max(200).default(''),
  value: z.string().max(500).default(''),
});

const careerProfileSchema = z.object({
  currentIndustry: z.string().max(120).default(''),
  department: z.string().max(120).default(''),
  roleCategory: z.string().max(120).default(''),
  jobRole: z.string().max(120).default(''),
  desiredJobType: z.string().max(60).default(''),
  desiredEmploymentType: z.string().max(60).default(''),
  preferredShift: z.string().max(60).default(''),
  preferredLocation: z.string().max(220).default(''),
  expectedSalary: z.string().max(80).default(''),
});

const personalDetailsSchema = z.object({
  gender: z.string().max(20).default(''),
  maritalStatus: z.string().max(30).default(''),
  dob: z.string().max(30).default(''),
  category: z.string().max(60).default(''),
  workPermit: z.string().max(140).default(''),
  address: z.string().max(400).default(''),
});

export const updateResumeProfileSchema = z.object({
  body: z.object({
    // Top-level profile mirrors — let the client push everything from the
    // resume profile in one round-trip instead of needing two PATCHes.
    headline: z.string().max(200).optional(),
    skills: z.array(z.string()).max(50).optional(),
    experienceYears: z.number().min(0).max(60).optional(),
    preferredLocations: z.array(z.string()).max(20).optional(),
    expectedSalaryMin: z.number().min(0).optional(),
    // Nested resumeProfile subdoc — the rich Naukri-style sections.
    profileSummary: z.string().max(2000).optional(),
    employments: z.array(employmentEntrySchema).max(15).optional(),
    educations: z.array(educationEntrySchema).max(10).optional(),
    itSkills: z.array(itSkillEntrySchema).max(25).optional(),
    projects: z.array(projectEntrySchema).max(10).optional(),
    languages: z.array(languageEntrySchema).max(10).optional(),
    accomplishments: z.array(accomplishmentEntrySchema).max(20).optional(),
    careerProfile: careerProfileSchema.optional(),
    personalDetails: personalDetailsSchema.optional(),
    diversityNote: z.string().max(1000).optional(),
  }),
});

// Keys that live at the top of `profile` rather than inside resumeProfile.
const TOP_LEVEL_PROFILE_KEYS = new Set([
  'headline',
  'skills',
  'experienceYears',
  'preferredLocations',
  'expectedSalaryMin',
]);

export const updateResumeProfile = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();

    const updates: Record<string, unknown> = {};
    let touchedResumeProfile = false;
    for (const [key, value] of Object.entries(req.body)) {
      if (value === undefined) continue;
      if (TOP_LEVEL_PROFILE_KEYS.has(key)) {
        updates[`profile.${key}`] = value;
      } else {
        updates[`profile.resumeProfile.${key}`] = value;
        touchedResumeProfile = true;
      }
    }
    if (touchedResumeProfile) {
      updates['profile.resumeProfile.updatedAt'] = new Date();
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true },
    );
    if (!user) throw ApiError.notFound('User not found');

    // Resume profile additions can push the user over the completion
    // threshold (longer summary, employments, etc.), so reuse the same
    // milestone hook the regular profile update uses.
    const completenessGrant = await maybeGrantProfileCompleteBonus(user);
    await invalidateProfileOptimizerCache(String(user._id));

    res.json({
      success: true,
      data: user.profile.resumeProfile ?? {},
      coinsAwarded: completenessGrant?.amount ?? 0,
      coinsBalance:
        completenessGrant?.balance ?? user.gamification?.coins ?? 0,
    });
  },
);

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(100),
  }),
});

export const switchRoleSchema = z.object({
  body: z.object({
    role: z.enum(['seeker', 'hirer']),
  }),
});

export const notificationPrefsSchema = z.object({
  body: z.object({
    push: z.boolean().optional(),
    email: z.boolean().optional(),
    whatsapp: z.boolean().optional(),
    jobAlerts: z.boolean().optional(),
    applicationUpdates: z.boolean().optional(),
    autoApplySummary: z.boolean().optional(),
    aiPolish: z.boolean().optional(),
    quietHoursStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    quietHoursEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
  }),
});

export const updateProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.body)) {
    updates[`profile.${key}`] = value;
  }

  const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true, runValidators: true });
  if (!user) throw ApiError.notFound('User not found');

  // Invalidate the Profile Coach cache so the next /ai/profile-optimizer
  // fetch reflects the changes the user just made (otherwise it'd keep
  // suggesting fields they already filled).
  await invalidateProfileOptimizerCache(String(user._id));

  // Profile-completion milestone bonus. Returns null when the user
  // isn't at 100% yet; returns a result (with granted=false on replay)
  // when they are. Either way the response carries the freshest wallet.
  const completenessGrant = await maybeGrantProfileCompleteBonus(user);

  res.json({
    success: true,
    message: 'Profile updated',
    data: user.profile,
    coinsAwarded: completenessGrant?.amount ?? 0,
    coinsBalance:
      completenessGrant?.balance ?? user.gamification?.coins ?? 0,
  });
});

export const changePassword = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id).select('+password');
  if (!user || !user.password) throw ApiError.badRequest('Password change unavailable for this account');

  const valid = await user.comparePassword(currentPassword);
  if (!valid) throw ApiError.unauthorized('Current password is incorrect');

  user.password = newPassword;
  await user.save();

  res.json({ success: true, message: 'Password changed' });
});

export const deleteAccount = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  await User.findByIdAndDelete(req.user._id);
  res.json({ success: true, message: 'Account deleted' });
});

/**
 * Toggle the active role on the User. Switching to 'hirer' requires that
 * a HirerProfile exists for this user — first-time hirers are bounced
 * with a 409 so the client can route them through company setup.
 */
export const switchRole = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { role } = req.body as { role: 'seeker' | 'hirer' };

  if (role === 'hirer') {
    const profile = await HirerProfile.findOne({ user: req.user._id }).select('_id').lean();
    if (!profile) {
      throw ApiError.conflict(
        'Set up a company profile before switching to hirer mode',
      );
    }
  }

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { $set: { activeRole: role } },
    { new: true },
  );
  if (!user) throw ApiError.notFound('User not found');

  res.json({
    success: true,
    data: { activeRole: user.activeRole },
  });
});

export const updateNotificationPrefs = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const body = req.body as z.infer<typeof notificationPrefsSchema>['body'];

    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) updates[`notificationPreferences.${k}`] = v;
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true },
    ).select('notificationPreferences');
    if (!user) throw ApiError.notFound('User not found');

    res.json({
      success: true,
      data: user.notificationPreferences,
    });
  },
);
