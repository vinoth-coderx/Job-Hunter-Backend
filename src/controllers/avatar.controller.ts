import { Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { redis, CACHE_KEYS } from '../config/redis';
import {
  CLOUDINARY_FOLDERS,
  destroyAsset,
  isCloudinaryConfigured,
  uploadBuffer,
} from '../config/cloudinary';

export const uploadAvatarHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  if (!req.file || !req.file.buffer) {
    throw ApiError.badRequest('No file uploaded — field name must be "avatar"');
  }
  if (!isCloudinaryConfigured()) {
    throw ApiError.internal('Cloudinary is not configured on the server');
  }

  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound('User not found');

  const oldPublicId = user.profile.avatarFile?.publicId;

  const result = await uploadBuffer(req.file.buffer, {
    folder: CLOUDINARY_FOLDERS.AVATAR,
    publicId: `user_${user._id.toString()}`,
    resourceType: 'image',
    overwrite: true,
    tags: ['avatar', `user:${user._id.toString()}`],
  });

  user.profile.avatarFile = {
    publicId: result.publicId,
    url: result.url,
    filename: result.publicId.split('/').pop() ?? result.publicId,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: result.bytes || req.file.size,
    uploadedAt: new Date(),
  };
  user.profile.avatar = result.url;
  await user.save();

  // Clean up the previous asset only when Cloudinary minted a new
  // public_id (we use a deterministic id so this is usually a no-op,
  // but covers the case where the schema-generated id changes).
  if (oldPublicId && oldPublicId !== result.publicId) {
    await destroyAsset(oldPublicId, 'image');
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

// Backward-compat: clients still hit `/api/v1/users/avatar/:userId` to
// resolve the avatar URL. We now redirect to the Cloudinary CDN URL.
export const getAvatarHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const targetUserId = (req.params.userId && String(req.params.userId)) || req.user.id;
  const user = await User.findById(targetUserId).select('profile.avatar profile.avatarFile');
  const url = user?.profile.avatar || user?.profile.avatarFile?.url;
  if (!url) throw ApiError.notFound('No avatar');

  res.redirect(302, url);
});

export const deleteAvatarHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id);
  if (!user || !user.profile.avatarFile) throw ApiError.notFound('No avatar to delete');

  const publicId = user.profile.avatarFile.publicId;
  user.profile.avatarFile = undefined;
  user.profile.avatar = undefined;
  await user.save();

  if (publicId) await destroyAsset(publicId, 'image');
  await redis.del(CACHE_KEYS.USER_PROFILE(req.user.id));

  res.json({ success: true, message: 'Avatar deleted' });
});
