"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadChatAttachment = exports.uploadOfficePhotos = exports.uploadCompanyLogo = exports.uploadAvatar = exports.uploadResume = exports.CHAT_ATTACHMENT_MAX_SIZE_BYTES = exports.OFFICE_PHOTO_MAX_SIZE_BYTES = exports.COMPANY_LOGO_MAX_SIZE_BYTES = exports.AVATAR_MAX_SIZE_BYTES = exports.RESUME_MAX_SIZE_BYTES = void 0;
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const ApiError_1 = require("../utils/ApiError");
exports.RESUME_MAX_SIZE_BYTES = 5 * 1024 * 1024;
exports.AVATAR_MAX_SIZE_BYTES = 2 * 1024 * 1024;
exports.COMPANY_LOGO_MAX_SIZE_BYTES = 2 * 1024 * 1024;
exports.OFFICE_PHOTO_MAX_SIZE_BYTES = 5 * 1024 * 1024;
exports.CHAT_ATTACHMENT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const RESUME_MIME = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const RESUME_EXT = new Set(['.pdf', '.doc', '.docx']);
const IMAGE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const CHAT_MIME = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
]);
const CHAT_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.webp', '.gif',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt',
]);
const buildFilter = (allowedMime, allowedExt, label) => (_req, file, cb) => {
    const ext = path_1.default.extname(file.originalname).toLowerCase();
    if (!allowedMime.has(file.mimetype) || !allowedExt.has(ext)) {
        cb(ApiError_1.ApiError.badRequest(`Only ${label} files are allowed`));
        return;
    }
    cb(null, true);
};
const memoryStorage = multer_1.default.memoryStorage();
exports.uploadResume = (0, multer_1.default)({
    storage: memoryStorage,
    fileFilter: buildFilter(RESUME_MIME, RESUME_EXT, 'PDF, DOC, or DOCX'),
    limits: { fileSize: exports.RESUME_MAX_SIZE_BYTES, files: 1 },
}).single('resume');
exports.uploadAvatar = (0, multer_1.default)({
    storage: memoryStorage,
    fileFilter: buildFilter(IMAGE_MIME, IMAGE_EXT, 'JPG, PNG, or WEBP image'),
    limits: { fileSize: exports.AVATAR_MAX_SIZE_BYTES, files: 1 },
}).single('avatar');
exports.uploadCompanyLogo = (0, multer_1.default)({
    storage: memoryStorage,
    fileFilter: buildFilter(IMAGE_MIME, IMAGE_EXT, 'JPG, PNG, or WEBP image'),
    limits: { fileSize: exports.COMPANY_LOGO_MAX_SIZE_BYTES, files: 1 },
}).single('logo');
exports.uploadOfficePhotos = (0, multer_1.default)({
    storage: memoryStorage,
    fileFilter: buildFilter(IMAGE_MIME, IMAGE_EXT, 'JPG, PNG, or WEBP image'),
    limits: { fileSize: exports.OFFICE_PHOTO_MAX_SIZE_BYTES, files: 10 },
}).array('photos', 10);
exports.uploadChatAttachment = (0, multer_1.default)({
    storage: memoryStorage,
    fileFilter: buildFilter(CHAT_MIME, CHAT_EXT, 'image (JPG/PNG/WEBP/GIF) or document (PDF/DOC/DOCX/XLS/XLSX/TXT)'),
    limits: { fileSize: exports.CHAT_ATTACHMENT_MAX_SIZE_BYTES, files: 1 },
}).single('file');
