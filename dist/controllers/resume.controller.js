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
exports.deleteResumeHandler = exports.downloadBrandedResumePdfHandler = exports.resumeOnboardHandler = exports.parseResumeHandler = exports.resumeMetaHandler = exports.downloadResumeHandler = exports.uploadResumeHandler = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_stream_1 = require("node:stream");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const User_1 = require("../models/User");
const logger_1 = require("../utils/logger");
const resumeParser_service_1 = require("../services/ai/resumeParser.service");
const resumeOnboarding_service_1 = require("../services/ai/combined/resumeOnboarding.service");
const quota_service_1 = require("../services/ai/quota.service");
const aiCreditWeights_1 = require("../config/aiCreditWeights");
const coin_service_1 = require("../services/coins/coin.service");
const Job_1 = require("../models/Job");
const constants_1 = require("../config/constants");
const cloudinary_1 = require("../config/cloudinary");
const resumePdf_service_1 = require("../services/resume/resumePdf.service");
const SIGNED_URL_TTL_SEC = 600;
const extractTextFromBuffer = async (buffer, mime) => {
    try {
        if (mime === 'application/pdf') {
            const { PDFParse } = await Promise.resolve().then(() => __importStar(require('pdf-parse')));
            const parser = new PDFParse({ data: new Uint8Array(buffer) });
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
            const result = await mammoth.extractRawText({ buffer });
            return (result.value || '').trim().slice(0, 20000);
        }
        return '';
    }
    catch (err) {
        logger_1.logger.warn('Resume text extraction failed', { err });
        return '';
    }
};
const formatFromMime = (mime) => {
    if (mime === 'application/pdf')
        return 'pdf';
    if (mime === 'application/msword')
        return 'doc';
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        return 'docx';
    }
    return 'bin';
};
exports.uploadResumeHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    if (!req.file || !req.file.buffer) {
        throw ApiError_1.ApiError.badRequest('No file uploaded — field name must be "resume"');
    }
    if (!(0, cloudinary_1.isCloudinaryConfigured)()) {
        throw ApiError_1.ApiError.internal('Cloudinary is not configured on the server');
    }
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const oldPublicId = user.profile.resumeFile?.publicId;
    const suffix = node_crypto_1.default.randomBytes(6).toString('hex');
    const fmt = formatFromMime(req.file.mimetype);
    const result = await (0, cloudinary_1.uploadBuffer)(req.file.buffer, {
        folder: cloudinary_1.CLOUDINARY_FOLDERS.RESUME,
        publicId: `user_${user._id.toString()}_${suffix}`,
        resourceType: 'raw',
        type: 'authenticated',
        overwrite: false,
        tags: ['resume', `user:${user._id.toString()}`],
        format: fmt,
    });
    if (!result.publicId) {
        logger_1.logger.error('Cloudinary upload returned empty publicId', { result });
        throw ApiError_1.ApiError.internal('Resume storage misconfigured: upload returned no asset id');
    }
    const resumeText = await extractTextFromBuffer(req.file.buffer, req.file.mimetype);
    user.profile.resumeFile = {
        publicId: result.publicId,
        url: result.url,
        filename: result.publicId.split('/').pop() ?? result.publicId,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: result.bytes || req.file.size,
        uploadedAt: new Date(),
    };
    user.profile.resumeUrl = result.url;
    if (resumeText)
        user.profile.resumeText = resumeText;
    user.markModified('profile.resumeFile');
    await user.save();
    const reread = await User_1.User.findById(user._id).select('profile.resumeFile').lean();
    const storedPublicId = reread?.profile?.resumeFile?.publicId;
    if (!storedPublicId) {
        logger_1.logger.error('Resume upload did not persist resumeFile', {
            userId: user._id.toString(),
            expectedPublicId: result.publicId,
            stored: reread?.profile?.resumeFile ?? null,
        });
        throw ApiError_1.ApiError.internal('Resume upload didn\'t persist correctly. Please contact support.');
    }
    if (oldPublicId && oldPublicId !== result.publicId) {
        await (0, cloudinary_1.destroyAsset)(oldPublicId, 'raw', 'authenticated');
    }
    const completenessGrant = await (0, coin_service_1.maybeGrantProfileCompleteBonus)(user);
    res.status(201).json({
        success: true,
        message: 'Resume uploaded',
        data: {
            file: user.profile.resumeFile,
            extractedTextLength: resumeText.length,
            downloadUrl: `/api/v1/users/resume`,
        },
        coinsAwarded: completenessGrant?.amount ?? 0,
        coinsBalance: completenessGrant?.balance ?? user.gamification?.coins ?? 0,
    });
});
exports.downloadResumeHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user || !user.profile.resumeFile?.publicId) {
        throw ApiError_1.ApiError.notFound('No resume on file');
    }
    const file = user.profile.resumeFile;
    const signed = (0, cloudinary_1.signedDeliveryUrl)(file.publicId, {
        resourceType: 'raw',
        type: 'authenticated',
        format: formatFromMime(file.mimeType),
        expiresInSec: SIGNED_URL_TTL_SEC,
        attachmentFilename: file.originalName,
    });
    try {
        const upstream = await fetch(signed, {
            redirect: 'follow',
            headers: { Accept: file.mimeType || 'application/octet-stream' },
        });
        if (!upstream.ok || !upstream.body) {
            logger_1.logger.warn('Resume proxy: upstream non-2xx', {
                status: upstream.status,
                publicId: file.publicId,
            });
            if (upstream.status === 404) {
                await User_1.User.updateOne({ _id: user._id }, { $unset: { 'profile.resumeFile': '' } }).catch((e) => {
                    logger_1.logger.warn('Resume proxy: failed to clear orphaned resumeFile', {
                        err: e.message,
                    });
                });
                throw ApiError_1.ApiError.gone('Your resume is no longer in storage. Please re-upload it.');
            }
            throw ApiError_1.ApiError.internal(`Resume storage returned ${upstream.status}. Please re-upload your resume.`);
        }
        res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
        if (file.size)
            res.setHeader('Content-Length', String(file.size));
        res.setHeader('Content-Disposition', `inline; filename="${file.originalName || 'resume'}"`);
        const nodeStream = node_stream_1.Readable.fromWeb(upstream.body);
        nodeStream.pipe(res);
        await new Promise((resolve, reject) => {
            nodeStream.on('end', resolve);
            nodeStream.on('error', reject);
            res.on('close', resolve);
        });
    }
    catch (err) {
        if (err instanceof ApiError_1.ApiError)
            throw err;
        logger_1.logger.warn('Resume proxy fetch failed', { err });
        throw ApiError_1.ApiError.internal('Could not load resume from storage');
    }
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
exports.parseResumeHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id).select('profile.resumeText profile.resumeFile');
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const text = user.profile.resumeText || '';
    if (!text) {
        res.json({
            success: true,
            message: 'No resume text available — upload a text-based PDF or DOCX first.',
            data: null,
        });
        return;
    }
    const parsed = await (0, resumeParser_service_1.parseResumeText)(text);
    res.json({ success: true, data: parsed });
});
exports.resumeOnboardHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const user = await User_1.User.findById(userId).select('profile.resumeText profile.fullName profile.skills');
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const text = user.profile.resumeText || '';
    if (!text) {
        res.json({
            success: true,
            message: 'No resume text available — upload a text-based PDF or DOCX first.',
            data: null,
        });
        return;
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)('resume_onboarding');
    const quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    const sinceMs = Date.now() - constants_1.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
    const candidates = await Job_1.Job.find({
        status: 'active',
        postedAt: { $gte: new Date(sinceMs) },
    })
        .sort({ postedAt: -1 })
        .limit(30)
        .lean();
    let result;
    try {
        result = await (0, resumeOnboarding_service_1.runResumeOnboarding)(text, candidates);
    }
    catch (err) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!result) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        res.json({
            success: true,
            message: 'Resume too short or AI unavailable',
            data: null,
            quota,
        });
        return;
    }
    res.json({ success: true, data: result, quota });
});
exports.downloadBrandedResumePdfHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const p = user.profile;
    const hasContent = Boolean(p.resumeProfile?.profileSummary) ||
        (p.skills && p.skills.length > 0) ||
        (p.resumeProfile?.employments && p.resumeProfile.employments.length > 0) ||
        (p.resumeProfile?.educations && p.resumeProfile.educations.length > 0);
    if (!hasContent) {
        throw ApiError_1.ApiError.badRequest('Fill in at least your summary, skills, or experience before downloading the branded resume');
    }
    const { buffer, filename } = await (0, resumePdf_service_1.generateBrandedResumePdf)(user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buffer);
});
exports.deleteResumeHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const hadAnything = Boolean(user.profile.resumeFile) ||
        Boolean(user.profile.resumeText) ||
        Boolean(user.profile.resumeUrl);
    if (!hadAnything) {
        res.json({ success: true, message: 'No resume to delete' });
        return;
    }
    const publicId = user.profile.resumeFile?.publicId;
    user.profile.resumeFile = undefined;
    user.profile.resumeText = undefined;
    user.profile.resumeUrl = undefined;
    await user.save();
    if (publicId)
        await (0, cloudinary_1.destroyAsset)(publicId, 'raw', 'authenticated');
    res.json({ success: true, message: 'Resume deleted' });
});
