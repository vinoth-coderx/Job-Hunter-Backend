"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadOfficePhotos = exports.uploadCompanyLogo = exports.uploadAvatar = exports.uploadResume = exports.OFFICE_PHOTO_MAX_SIZE_BYTES = exports.COMPANY_LOGO_MAX_SIZE_BYTES = exports.AVATAR_MAX_SIZE_BYTES = exports.RESUME_MAX_SIZE_BYTES = exports.OFFICE_PHOTO_DIR = exports.COMPANY_LOGO_DIR = exports.AVATAR_DIR = exports.RESUME_DIR = void 0;
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const ApiError_1 = require("../utils/ApiError");
const UPLOAD_ROOT = path_1.default.resolve(process.cwd(), 'uploads');
exports.RESUME_DIR = path_1.default.join(UPLOAD_ROOT, 'resumes');
exports.AVATAR_DIR = path_1.default.join(UPLOAD_ROOT, 'avatars');
exports.COMPANY_LOGO_DIR = path_1.default.join(UPLOAD_ROOT, 'company-logos');
exports.OFFICE_PHOTO_DIR = path_1.default.join(UPLOAD_ROOT, 'office-photos');
exports.RESUME_MAX_SIZE_BYTES = 5 * 1024 * 1024;
exports.AVATAR_MAX_SIZE_BYTES = 2 * 1024 * 1024;
exports.COMPANY_LOGO_MAX_SIZE_BYTES = 2 * 1024 * 1024;
exports.OFFICE_PHOTO_MAX_SIZE_BYTES = 5 * 1024 * 1024;
for (const dir of [exports.RESUME_DIR, exports.AVATAR_DIR, exports.COMPANY_LOGO_DIR, exports.OFFICE_PHOTO_DIR]) {
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
}
const RESUME_MIME = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const RESUME_EXT = new Set(['.pdf', '.doc', '.docx']);
const AVATAR_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const AVATAR_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const buildStorage = (dir) => multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
        const userId = req.user?.id || 'anon';
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        const random = crypto_1.default.randomBytes(8).toString('hex');
        cb(null, `${userId}-${Date.now()}-${random}${ext}`);
    },
});
const buildFilter = (allowedMime, allowedExt, label) => (_req, file, cb) => {
    const ext = path_1.default.extname(file.originalname).toLowerCase();
    if (!allowedMime.has(file.mimetype) || !allowedExt.has(ext)) {
        cb(ApiError_1.ApiError.badRequest(`Only ${label} files are allowed`));
        return;
    }
    cb(null, true);
};
exports.uploadResume = (0, multer_1.default)({
    storage: buildStorage(exports.RESUME_DIR),
    fileFilter: buildFilter(RESUME_MIME, RESUME_EXT, 'PDF, DOC, or DOCX'),
    limits: { fileSize: exports.RESUME_MAX_SIZE_BYTES, files: 1 },
}).single('resume');
exports.uploadAvatar = (0, multer_1.default)({
    storage: buildStorage(exports.AVATAR_DIR),
    fileFilter: buildFilter(AVATAR_MIME, AVATAR_EXT, 'JPG, PNG, or WEBP image'),
    limits: { fileSize: exports.AVATAR_MAX_SIZE_BYTES, files: 1 },
}).single('avatar');
exports.uploadCompanyLogo = (0, multer_1.default)({
    storage: buildStorage(exports.COMPANY_LOGO_DIR),
    fileFilter: buildFilter(AVATAR_MIME, AVATAR_EXT, 'JPG, PNG, or WEBP image'),
    limits: { fileSize: exports.COMPANY_LOGO_MAX_SIZE_BYTES, files: 1 },
}).single('logo');
exports.uploadOfficePhotos = (0, multer_1.default)({
    storage: buildStorage(exports.OFFICE_PHOTO_DIR),
    fileFilter: buildFilter(AVATAR_MIME, AVATAR_EXT, 'JPG, PNG, or WEBP image'),
    limits: { fileSize: exports.OFFICE_PHOTO_MAX_SIZE_BYTES, files: 10 },
}).array('photos', 10);
