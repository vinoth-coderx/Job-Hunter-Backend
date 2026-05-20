"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyUploadSafety = void 0;
const ApiError_1 = require("../utils/ApiError");
const SecurityEvent_1 = require("../models/SecurityEvent");
const logger_1 = require("../utils/logger");
const SIGS = [
    { name: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
    { name: 'jpg', bytes: [0xff, 0xd8, 0xff] },
    { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { name: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
    { name: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
    { name: 'doc', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
    { name: 'docx-zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
    { name: 'xls', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];
const matchesSig = (buf, sig) => {
    const offset = sig.offset ?? 0;
    if (buf.length < offset + sig.bytes.length)
        return false;
    for (let i = 0; i < sig.bytes.length; i++) {
        if (buf[offset + i] !== sig.bytes[i])
            return false;
    }
    return true;
};
const looksSafe = (buf) => SIGS.some((s) => matchesSig(buf, s));
const SUSPICIOUS_PATTERNS = [
    Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
    Buffer.from('/JavaScript'),
    Buffer.from('/JS'),
    Buffer.from('<script'),
];
const looksSuspicious = (buf) => SUSPICIOUS_PATTERNS.some((p) => buf.includes(p));
const verifyUploadSafety = async (req, _res, next) => {
    const files = [];
    const reqFile = req.file;
    if (reqFile)
        files.push(reqFile);
    const reqFiles = req.files;
    if (Array.isArray(reqFiles))
        files.push(...reqFiles);
    for (const f of files) {
        if (!f.buffer)
            continue;
        if (!looksSafe(f.buffer)) {
            logger_1.logger.warn(`[fileSafety] magic number mismatch: ${f.originalname}`);
            return next(new ApiError_1.ApiError(400, 'Uploaded file did not match its declared type'));
        }
        if (looksSuspicious(f.buffer)) {
            await SecurityEvent_1.SecurityEvent.create({
                user: req.userId
                    ? undefined
                    : undefined,
                type: 'malware_upload_blocked',
                severity: 'high',
                ip: req.ip,
                userAgent: req.headers['user-agent'],
                metadata: { filename: f.originalname },
            }).catch(() => undefined);
            return next(new ApiError_1.ApiError(400, 'Upload blocked: file appears unsafe'));
        }
    }
    next();
};
exports.verifyUploadSafety = verifyUploadSafety;
