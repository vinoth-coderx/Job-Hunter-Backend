/**
 * Multer middleware — uses memory storage exclusively. Files arrive in
 * `req.file.buffer` (or `req.files[].buffer`) and the controllers stream
 * them straight to Cloudinary; nothing is ever written to local disk.
 *
 * Size + MIME limits live here so the multipart parser rejects bad
 * payloads before any controller logic runs.
 */

import multer from 'multer';

/// Mirrors multer's FileFilterCallback signature without depending on
/// the named export — keeps the build green when @types/multer's full
/// namespace isn't loaded.
type FileFilterCallback = {
  (error: Error): void;
  (error: null, acceptFile: boolean): void;
};
import path from 'path';
import { Request } from 'express';
import { ApiError } from '../utils/ApiError';

export const RESUME_MAX_SIZE_BYTES = 5 * 1024 * 1024;
export const AVATAR_MAX_SIZE_BYTES = 2 * 1024 * 1024;
export const COMPANY_LOGO_MAX_SIZE_BYTES = 2 * 1024 * 1024;
export const OFFICE_PHOTO_MAX_SIZE_BYTES = 5 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

const RESUME_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const RESUME_EXT = new Set(['.pdf', '.doc', '.docx']);

const IMAGE_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Chat attachments accept images + common docs. Videos/audio are
// intentionally excluded to keep the 10MB ceiling realistic and dodge
// Cloudinary's video transcoding pricing tier.
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

/// Minimal subset of multer's File interface — defined locally so the
/// build doesn't depend on @types/multer's `Express.Multer.File`
/// augmentation resolving in every deploy environment (Render's prod
/// install sometimes skips devDependencies and the augmentation goes
/// missing).
interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const buildFilter =
  (allowedMime: Set<string>, allowedExt: Set<string>, label: string) =>
  (_req: Request, file: UploadedFile, cb: FileFilterCallback): void => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedMime.has(file.mimetype) || !allowedExt.has(ext)) {
      cb(ApiError.badRequest(`Only ${label} files are allowed`));
      return;
    }
    cb(null, true);
  };

const memoryStorage = multer.memoryStorage();

export const uploadResume = multer({
  storage: memoryStorage,
  fileFilter: buildFilter(RESUME_MIME, RESUME_EXT, 'PDF, DOC, or DOCX'),
  limits: { fileSize: RESUME_MAX_SIZE_BYTES, files: 1 },
}).single('resume');

export const uploadAvatar = multer({
  storage: memoryStorage,
  fileFilter: buildFilter(IMAGE_MIME, IMAGE_EXT, 'JPG, PNG, or WEBP image'),
  limits: { fileSize: AVATAR_MAX_SIZE_BYTES, files: 1 },
}).single('avatar');

export const uploadCompanyLogo = multer({
  storage: memoryStorage,
  fileFilter: buildFilter(IMAGE_MIME, IMAGE_EXT, 'JPG, PNG, or WEBP image'),
  limits: { fileSize: COMPANY_LOGO_MAX_SIZE_BYTES, files: 1 },
}).single('logo');

export const uploadOfficePhotos = multer({
  storage: memoryStorage,
  fileFilter: buildFilter(IMAGE_MIME, IMAGE_EXT, 'JPG, PNG, or WEBP image'),
  limits: { fileSize: OFFICE_PHOTO_MAX_SIZE_BYTES, files: 10 },
}).array('photos', 10);

export const uploadChatAttachment = multer({
  storage: memoryStorage,
  fileFilter: buildFilter(CHAT_MIME, CHAT_EXT, 'image (JPG/PNG/WEBP/GIF) or document (PDF/DOC/DOCX/XLS/XLSX/TXT)'),
  limits: { fileSize: CHAT_ATTACHMENT_MAX_SIZE_BYTES, files: 1 },
}).single('file');
