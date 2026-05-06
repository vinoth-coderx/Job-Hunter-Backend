import { Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { redis, CACHE_KEYS } from '../config/redis';
import { AVATAR_DIR } from '../middleware/upload';

const removeFileQuiet = async (filename?: string): Promise<void> => {
  if (!filename) return;
  try {
    await fs.unlink(path.join(AVATAR_DIR, filename));
  } catch {
    // already gone
  }
};

export const uploadAvatarHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  if (!req.file) throw ApiError.badRequest('No file uploaded — field name must be "avatar"');

  const user = await User.findById(req.user._id);
  if (!user) {
    await removeFileQuiet(req.file.filename);
    throw ApiError.notFound('User not found');
  }

  const oldFilename = user.profile.avatarFile?.filename;

  user.profile.avatarFile = {
    filename: req.file.filename,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedAt: new Date(),
  };
  user.profile.avatar = `/api/v1/users/avatar/${req.user.id}`;
  await user.save();

  if (oldFilename && oldFilename !== req.file.filename) {
    await removeFileQuiet(oldFilename);
  }

  await redis.del(CACHE_KEYS.USER_PROFILE(req.user.id));

  res.status(201).json({
    success: true,
    message: 'Avatar uploaded',
    data: {
      file: user.profile.avatarFile,
      url: user.profile.avatar,
    },
  });
});

export const getAvatarHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const targetUserId = (req.params.userId && String(req.params.userId)) || req.user.id;
  const user = await User.findById(targetUserId).select('profile.avatarFile');
  if (!user || !user.profile.avatarFile) throw ApiError.notFound('No avatar');

  const filePath = path.join(AVATAR_DIR, user.profile.avatarFile.filename);
  try {
    await fs.access(filePath);
  } catch {
    throw ApiError.notFound('Avatar file missing on disk');
  }

  res.setHeader('Content-Type', user.profile.avatarFile.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath);
});

export const deleteAvatarHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id);
  if (!user || !user.profile.avatarFile) throw ApiError.notFound('No avatar to delete');

  const filename = user.profile.avatarFile.filename;
  user.profile.avatarFile = undefined;
  user.profile.avatar = undefined;
  await user.save();

  await removeFileQuiet(filename);
  await redis.del(CACHE_KEYS.USER_PROFILE(req.user.id));

  res.json({ success: true, message: 'Avatar deleted' });
});
