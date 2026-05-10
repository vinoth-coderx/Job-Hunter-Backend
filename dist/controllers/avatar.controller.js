"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAvatarHandler = exports.getAvatarHandler = exports.uploadAvatarHandler = void 0;
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const User_1 = require("../models/User");
const redis_1 = require("../config/redis");
const cloudinary_1 = require("../config/cloudinary");
exports.uploadAvatarHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    if (!req.file || !req.file.buffer) {
        throw ApiError_1.ApiError.badRequest('No file uploaded — field name must be "avatar"');
    }
    if (!(0, cloudinary_1.isCloudinaryConfigured)()) {
        throw ApiError_1.ApiError.internal('Cloudinary is not configured on the server');
    }
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const oldPublicId = user.profile.avatarFile?.publicId;
    const result = await (0, cloudinary_1.uploadBuffer)(req.file.buffer, {
        folder: cloudinary_1.CLOUDINARY_FOLDERS.AVATAR,
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
    if (oldPublicId && oldPublicId !== result.publicId) {
        await (0, cloudinary_1.destroyAsset)(oldPublicId, 'image');
    }
    await redis_1.redis.del(redis_1.CACHE_KEYS.USER_PROFILE(req.user.id));
    res.status(201).json({
        success: true,
        message: 'Avatar uploaded',
        data: {
            file: user.profile.avatarFile,
            url: user.profile.avatar,
        },
    });
});
exports.getAvatarHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const targetUserId = (req.params.userId && String(req.params.userId)) || req.user.id;
    const user = await User_1.User.findById(targetUserId).select('profile.avatar profile.avatarFile');
    const url = user?.profile.avatar || user?.profile.avatarFile?.url;
    if (!url)
        throw ApiError_1.ApiError.notFound('No avatar');
    res.redirect(302, url);
});
exports.deleteAvatarHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user || !user.profile.avatarFile)
        throw ApiError_1.ApiError.notFound('No avatar to delete');
    const publicId = user.profile.avatarFile.publicId;
    user.profile.avatarFile = undefined;
    user.profile.avatar = undefined;
    await user.save();
    if (publicId)
        await (0, cloudinary_1.destroyAsset)(publicId, 'image');
    await redis_1.redis.del(redis_1.CACHE_KEYS.USER_PROFILE(req.user.id));
    res.json({ success: true, message: 'Avatar deleted' });
});
