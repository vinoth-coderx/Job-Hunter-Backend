import { Response } from 'express';
import { z } from 'zod';
import { User } from '../models/User';
import { HirerProfile } from '../models/HirerProfile';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { AuthRequest } from '../types';

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

  res.json({ success: true, message: 'Profile updated', data: user.profile });
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
