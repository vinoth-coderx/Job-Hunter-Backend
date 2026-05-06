import { Response } from 'express';
import { z } from 'zod';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { AuthRequest } from '../types';
import { redis, CACHE_KEYS } from '../config/redis';

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

export const updateProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.body)) {
    updates[`profile.${key}`] = value;
  }

  const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true, runValidators: true });
  if (!user) throw ApiError.notFound('User not found');

  await redis.del(CACHE_KEYS.USER_PROFILE(req.user.id));
  const matchKeys = await redis.keys(`match:${req.user.id}:*`);
  if (matchKeys.length) await redis.del(...matchKeys);
  await redis.del(CACHE_KEYS.USER_MATCHED_JOBS(req.user.id));

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
  await redis.del(CACHE_KEYS.USER_PROFILE(req.user.id));
  res.json({ success: true, message: 'Account deleted' });
});
