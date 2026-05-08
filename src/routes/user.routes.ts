import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import {
  updateProfile,
  changePassword,
  deleteAccount,
  switchRole,
  updateNotificationPrefs,
  updateProfileSchema,
  changePasswordSchema,
  switchRoleSchema,
  notificationPrefsSchema,
} from '../controllers/user.controller';
import {
  uploadResumeHandler,
  downloadResumeHandler,
  resumeMetaHandler,
  deleteResumeHandler,
} from '../controllers/resume.controller';
import {
  uploadAvatarHandler,
  getAvatarHandler,
  deleteAvatarHandler,
} from '../controllers/avatar.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  uploadResume,
  uploadAvatar,
  RESUME_MAX_SIZE_BYTES,
  AVATAR_MAX_SIZE_BYTES,
} from '../middleware/upload';
import { ApiError } from '../utils/ApiError';

const router = Router();

router.use(authenticate);

router.patch('/profile', validate(updateProfileSchema), updateProfile);
router.post('/change-password', validate(changePasswordSchema), changePassword);
router.post('/switch-role', validate(switchRoleSchema), switchRole);
router.put(
  '/notification-prefs',
  validate(notificationPrefsSchema),
  updateNotificationPrefs,
);

const wrapMulter =
  (mw: RequestHandler, maxBytes: number) =>
  (req: Request, res: Response, next: NextFunction): void => {
    mw(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(
            ApiError.badRequest(`File too large — max ${Math.round(maxBytes / 1024 / 1024)}MB`),
          );
        }
        return next(ApiError.badRequest(`Upload error: ${err.message}`));
      }
      return next(err);
    });
  };

router.post('/resume', wrapMulter(uploadResume, RESUME_MAX_SIZE_BYTES), uploadResumeHandler);
router.get('/resume', downloadResumeHandler);
router.get('/resume/meta', resumeMetaHandler);
router.delete('/resume', deleteResumeHandler);

router.post('/avatar', wrapMulter(uploadAvatar, AVATAR_MAX_SIZE_BYTES), uploadAvatarHandler);
router.get('/avatar', getAvatarHandler);
router.get('/avatar/:userId', getAvatarHandler);
router.delete('/avatar', deleteAvatarHandler);

router.delete('/account', deleteAccount);

export default router;
