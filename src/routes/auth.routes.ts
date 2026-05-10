import { Router } from 'express';
import {
  register,
  login,
  refreshToken,
  logout,
  me,
  guestLogin,
  firebaseLogin,
  checkEmailExists,
  registerSchema,
  loginSchema,
  firebaseLoginSchema,
  checkEmailExistsSchema,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/refresh', refreshToken);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, me);

// Firebase Auth hybrid: client supplies a Firebase ID token (from any
// Firebase provider — Google, email/password, phone, …), we verify it
// and mint our own JWT pair. This is the only Google sign-in path now;
// the legacy passport-google-oauth20 web flow and the direct
// /auth/google/mobile fallback were removed when the app committed
// fully to Firebase.
router.post('/firebase', authLimiter, validate(firebaseLoginSchema), firebaseLogin);

// Pre-flight for the forgot-password flow — Firebase silently succeeds on
// reset for unknown emails, so we ask the server first whether the email
// is registered and surface a clear message in the UI.
router.post(
  '/check-email-exists',
  authLimiter,
  validate(checkEmailExistsSchema),
  checkEmailExists,
);

router.post('/guest', authLimiter, guestLogin);

export default router;
