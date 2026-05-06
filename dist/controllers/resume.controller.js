"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteResumeHandler = exports.resumeMetaHandler = exports.downloadResumeHandler = exports.uploadResumeHandler = void 0;
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const User_1 = require("../models/User");
const redis_1 = require("../config/redis");
const logger_1 = require("../utils/logger");
const upload_1 = require("../middleware/upload");
const extractText = async (filePath, mime) => {
    try {
        if (mime === 'application/pdf') {
            const { PDFParse } = await Promise.resolve().then(() => __importStar(require('pdf-parse')));
            const buf = await promises_1.default.readFile(filePath);
            const parser = new PDFParse({ data: new Uint8Array(buf) });
            try {
                const result = await parser.getText();
                const text = result.pages?.map((p) => p.text || '').join('\n') || result.text || '';
                return text.trim().slice(0, 20000);
            }
            finally {
                await parser.destroy().catch(() => { });
            }
        }
        if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            mime === 'application/msword') {
            const mammoth = await Promise.resolve().then(() => __importStar(require('mammoth')));
            const result = await mammoth.extractRawText({ path: filePath });
            return (result.value || '').trim().slice(0, 20000);
        }
        return '';
    }
    catch (err) {
        logger_1.logger.warn('Resume text extraction failed', { filePath, err });
        return '';
    }
};
const removeFileQuiet = async (filename) => {
    if (!filename)
        return;
    try {
        await promises_1.default.unlink(path_1.default.join(upload_1.RESUME_DIR, filename));
    }
    catch {
    }
};
exports.uploadResumeHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    if (!req.file)
        throw ApiError_1.ApiError.badRequest('No file uploaded — field name must be "resume"');
    const user = await User_1.User.findById(req.user._id);
    if (!user) {
        await removeFileQuiet(req.file.filename);
        throw ApiError_1.ApiError.notFound('User not found');
    }
    const oldFilename = user.profile.resumeFile?.filename;
    const resumeText = await extractText(req.file.path, req.file.mimetype);
    user.profile.resumeFile = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date(),
    };
    if (resumeText)
        user.profile.resumeText = resumeText;
    await user.save();
    if (oldFilename && oldFilename !== req.file.filename) {
        await removeFileQuiet(oldFilename);
    }
    await redis_1.redis.del(redis_1.CACHE_KEYS.USER_PROFILE(req.user.id));
    const matchKeys = await redis_1.redis.keys(`match:${req.user.id}:*`);
    if (matchKeys.length)
        await redis_1.redis.del(...matchKeys);
    const feedKeys = await redis_1.redis.keys(`${redis_1.CACHE_KEYS.USER_MATCHED_JOBS(req.user.id)}*`);
    if (feedKeys.length)
        await redis_1.redis.del(...feedKeys);
    res.status(201).json({
        success: true,
        message: 'Resume uploaded',
        data: {
            file: user.profile.resumeFile,
            extractedTextLength: resumeText.length,
            downloadUrl: `/api/v1/users/resume`,
        },
    });
});
exports.downloadResumeHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user || !user.profile.resumeFile)
        throw ApiError_1.ApiError.notFound('No resume on file');
    const filePath = path_1.default.join(upload_1.RESUME_DIR, user.profile.resumeFile.filename);
    try {
        await promises_1.default.access(filePath);
    }
    catch {
        throw ApiError_1.ApiError.notFound('Resume file missing on disk');
    }
    res.setHeader('Content-Type', user.profile.resumeFile.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${user.profile.resumeFile.originalName.replace(/"/g, '')}"`);
    res.sendFile(filePath);
});
exports.resumeMetaHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id).select('profile.resumeFile profile.resumeText');
    if (!user || !user.profile.resumeFile) {
        res.json({ success: true, data: null });
        return;
    }
    res.json({
        success: true,
        data: {
            file: user.profile.resumeFile,
            hasExtractedText: !!user.profile.resumeText,
            extractedTextLength: user.profile.resumeText?.length || 0,
            downloadUrl: `/api/v1/users/resume`,
        },
    });
});
exports.deleteResumeHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user || !user.profile.resumeFile)
        throw ApiError_1.ApiError.notFound('No resume to delete');
    const filename = user.profile.resumeFile.filename;
    user.profile.resumeFile = undefined;
    user.profile.resumeText = undefined;
    await user.save();
    await removeFileQuiet(filename);
    await redis_1.redis.del(redis_1.CACHE_KEYS.USER_PROFILE(req.user.id));
    res.json({ success: true, message: 'Resume deleted' });
});
