import { Response } from 'express';
import { z } from 'zod';
import { DeviceToken } from '../models/DeviceToken';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';

export const registerTokenSchema = z.object({
  body: z.object({
    token: z.string().min(20).max(2048),
    platform: z.enum(['ios', 'android', 'web']),
    appVersion: z.string().max(40).optional(),
  }),
});

/// Upsert by token: if the same FCM token is sent again (e.g. user
/// signed in on a fresh install with the same device), we just bump
/// `lastSeenAt` and re-bind it to the current user.
export const registerDeviceToken = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { token, platform, appVersion } = req.body;

  const updated = await DeviceToken.findOneAndUpdate(
    { token },
    {
      $set: {
        user: req.user._id,
        platform,
        appVersion,
        lastSeenAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  res.status(201).json({ success: true, data: updated });
});

export const unregisterDeviceToken = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { token } = req.params;
  await DeviceToken.deleteOne({ token, user: req.user._id });
  res.json({ success: true, message: 'Token unregistered' });
});
