import { Router } from 'express';
import {
  sendOtp,
  sendOtpSchema,
  verifyOtpHandler,
  verifyOtpSchema,
  start2faEnrollment,
  finish2faEnrollment,
  verify2fa,
  verify2faSchema,
  disable2faHandler,
  listSessions,
  revokeSessionHandler,
  revokeAllSessionsHandler,
  updatePrivacy,
  updatePrivacySchema,
  listResumeAccessLog,
  checkPasswordStrength,
  checkPasswordStrengthSchema,
} from '../controllers/security.controller';
import { authenticate } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';

const router = Router();

router.post('/otp/send', authLimiter, validate(sendOtpSchema), sendOtp);
router.post('/otp/verify', authLimiter, validate(verifyOtpSchema), verifyOtpHandler);

router.post('/2fa/enroll', authenticate, start2faEnrollment);
router.post('/2fa/enroll/verify', authenticate, validate(verify2faSchema), finish2faEnrollment);
router.post('/2fa/verify', authenticate, validate(verify2faSchema), verify2fa);
router.delete('/2fa', authenticate, disable2faHandler);

router.get('/sessions', authenticate, listSessions);
router.delete('/sessions/:id', authenticate, revokeSessionHandler);
router.post('/sessions/revoke-all', authenticate, revokeAllSessionsHandler);

router.patch('/privacy', authenticate, validate(updatePrivacySchema), updatePrivacy);

router.get('/resume-access-log', authenticate, listResumeAccessLog);
router.post('/password/strength', validate(checkPasswordStrengthSchema), checkPasswordStrength);

export default router;
