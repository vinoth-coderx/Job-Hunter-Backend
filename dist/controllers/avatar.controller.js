"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAvatarHandler = exports.getAvatarHandler = exports.uploadAvatarHandler = void 0;
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const User_1 = require("../models/User");
const redis_1 = require("../config/redis");
const upload_1 = require("../middleware/upload");
const removeFileQuiet = async (filename) => {
    if (!filename)
        return;
    try {
        await promises_1.default.unlink(path_1.default.join(upload_1.AVATAR_DIR, filename));
    }
    catch {
    }
};
exports.uploadAvatarHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    if (!req.file)
        throw ApiError_1.ApiError.badRequest('No file uploaded — field name must be "avatar"');
    const user = await User_1.User.findById(req.user._id);
    if (!user) {
        await removeFileQuiet(req.file.filename);
        throw ApiError_1.ApiError.notFound('User not found');
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
    const user = await User_1.User.findById(targetUserId).select('profile.avatarFile');
    if (!user || !user.profile.avatarFile)
        throw ApiError_1.ApiError.notFound('No avatar');
    const filePath = path_1.default.join(upload_1.AVATAR_DIR, user.profile.avatarFile.filename);
    try {
        await promises_1.default.access(filePath);
    }
    catch {
        throw ApiError_1.ApiError.notFound('Avatar file missing on disk');
    }
    res.setHeader('Content-Type', user.profile.avatarFile.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(filePath);
});
exports.deleteAvatarHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user || !user.profile.avatarFile)
        throw ApiError_1.ApiError.notFound('No avatar to delete');
    const filename = user.profile.avatarFile.filename;
    user.profile.avatarFile = undefined;
    user.profile.avatar = undefined;
    await user.save();
    await removeFileQuiet(filename);
    await redis_1.redis.del(redis_1.CACHE_KEYS.USER_PROFILE(req.user.id));
    res.json({ success: true, message: 'Avatar deleted' });
});
