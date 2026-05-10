"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cloudinary = exports.publicIdFromUrl = exports.signedDeliveryUrl = exports.destroyAsset = exports.uploadBuffer = exports.CLOUDINARY_FOLDERS = exports.isCloudinaryConfigured = void 0;
const cloudinary_1 = require("cloudinary");
Object.defineProperty(exports, "cloudinary", { enumerable: true, get: function () { return cloudinary_1.v2; } });
const node_stream_1 = require("node:stream");
const env_1 = require("./env");
const logger_1 = require("../utils/logger");
let configured = false;
const ensureConfigured = () => {
    if (configured)
        return true;
    const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env_1.env;
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
        return false;
    }
    cloudinary_1.v2.config({
        cloud_name: CLOUDINARY_CLOUD_NAME,
        api_key: CLOUDINARY_API_KEY,
        api_secret: CLOUDINARY_API_SECRET,
        secure: true,
    });
    configured = true;
    logger_1.logger.info(`Cloudinary configured (cloud_name=${CLOUDINARY_CLOUD_NAME})`);
    return true;
};
const isCloudinaryConfigured = () => Boolean(env_1.env.CLOUDINARY_CLOUD_NAME && env_1.env.CLOUDINARY_API_KEY && env_1.env.CLOUDINARY_API_SECRET);
exports.isCloudinaryConfigured = isCloudinaryConfigured;
exports.CLOUDINARY_FOLDERS = {
    AVATAR: 'job_hunter/avatars',
    RESUME: 'job_hunter/resumes',
    COMPANY_LOGO: 'job_hunter/company_logos',
    OFFICE_PHOTO: 'job_hunter/office_photos',
    CHAT_ATTACHMENT: 'job_hunter/chat_attachments',
};
const uploadBuffer = (buffer, opts) => {
    if (!ensureConfigured()) {
        return Promise.reject(new Error('Cloudinary not configured — set CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET'));
    }
    const uploadOptions = {
        folder: opts.folder,
        public_id: opts.publicId,
        resource_type: opts.resourceType ?? 'image',
        type: opts.type ?? 'upload',
        overwrite: opts.overwrite ?? true,
        tags: opts.tags,
        format: opts.format,
        use_filename: false,
        unique_filename: !opts.publicId,
    };
    return new Promise((resolve, reject) => {
        const stream = cloudinary_1.v2.uploader.upload_stream(uploadOptions, (err, result) => {
            if (err || !result) {
                return reject(err ?? new Error('Cloudinary upload returned no result'));
            }
            resolve({
                url: result.secure_url,
                publicId: result.public_id,
                bytes: result.bytes ?? 0,
                format: result.format ?? '',
                resourceType: result.resource_type ?? 'image',
                type: result.type ?? 'upload',
                width: result.width,
                height: result.height,
            });
        });
        node_stream_1.Readable.from(buffer).pipe(stream);
    });
};
exports.uploadBuffer = uploadBuffer;
const destroyAsset = async (publicId, resourceType = 'image', type = 'upload') => {
    if (!ensureConfigured())
        return;
    if (!publicId)
        return;
    try {
        await cloudinary_1.v2.uploader.destroy(publicId, {
            resource_type: resourceType,
            type,
            invalidate: true,
        });
    }
    catch (err) {
        logger_1.logger.warn('Cloudinary destroy failed', { publicId, err });
    }
};
exports.destroyAsset = destroyAsset;
const signedDeliveryUrl = (publicId, opts = {}) => {
    if (!ensureConfigured()) {
        throw new Error('Cloudinary not configured — cannot sign URL');
    }
    const expiresAt = Math.floor(Date.now() / 1000) + (opts.expiresInSec ?? 600);
    return cloudinary_1.v2.url(publicId, {
        sign_url: true,
        type: opts.type ?? 'authenticated',
        resource_type: opts.resourceType ?? 'raw',
        secure: true,
        format: opts.format,
        expires_at: expiresAt,
        attachment: opts.attachmentFilename,
    });
};
exports.signedDeliveryUrl = signedDeliveryUrl;
const publicIdFromUrl = (url) => {
    if (!url)
        return null;
    try {
        const parsed = new URL(url);
        if (!parsed.hostname.includes('cloudinary.com'))
            return null;
        const match = parsed.pathname.match(/\/(?:image|raw|video)\/(?:upload|authenticated|private)\/(?:v\d+\/)?(.+?)(?:\.[a-z0-9]+)?$/i);
        return match?.[1] ?? null;
    }
    catch {
        return null;
    }
};
exports.publicIdFromUrl = publicIdFromUrl;
