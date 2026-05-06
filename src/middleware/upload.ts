import multer, { FileFilterCallback, StorageEngine } from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Request } from 'express';
import { ApiError } from '../utils/ApiError';

const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');
export const RESUME_DIR = path.join(UPLOAD_ROOT, 'resumes');
export const AVATAR_DIR = path.join(UPLOAD_ROOT, 'avatars');

export const RESUME_MAX_SIZE_BYTES = 5 * 1024 * 1024;
export const AVATAR_MAX_SIZE_BYTES = 2 * 1024 * 1024;

for (const dir of [RESUME_DIR, AVATAR_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const RESUME_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const RESUME_EXT = new Set(['.pdf', '.doc', '.docx']);

const AVATAR_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const AVATAR_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const buildStorage = (dir: string): StorageEngine =>
  multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const userId = req.user?.id || 'anon';
      const ext = path.extname(file.originalname).toLowerCase();
      const random = crypto.randomBytes(8).toString('hex');
      cb(null, `${userId}-${Date.now()}-${random}${ext}`);
    },
  });

const buildFilter =
  (allowedMime: Set<string>, allowedExt: Set<string>, label: string) =>
  (_req: Request, file: Express.Multer.File, cb: FileFilterCallback): void => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedMime.has(file.mimetype) || !allowedExt.has(ext)) {
      cb(ApiError.badRequest(`Only ${label} files are allowed`));
      return;
    }
    cb(null, true);
  };

export const uploadResume = multer({
  storage: buildStorage(RESUME_DIR),
  fileFilter: buildFilter(RESUME_MIME, RESUME_EXT, 'PDF, DOC, or DOCX'),
  limits: { fileSize: RESUME_MAX_SIZE_BYTES, files: 1 },
}).single('resume');

export const uploadAvatar = multer({
  storage: buildStorage(AVATAR_DIR),
  fileFilter: buildFilter(AVATAR_MIME, AVATAR_EXT, 'JPG, PNG, or WEBP image'),
  limits: { fileSize: AVATAR_MAX_SIZE_BYTES, files: 1 },
}).single('avatar');
