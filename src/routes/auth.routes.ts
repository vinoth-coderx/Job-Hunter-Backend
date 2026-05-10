import { Router } from 'express';
import passport from 'passport';
import {
  register,
  login,
  refreshToken,
  logout,
  me,
  googleCallback,
  googleMobileLogin,
  guestLogin,
  firebaseLogin,
  checkEmailExists,
  registerSchema,
  loginSchema,
  googleMobileSchema,
  firebaseLoginSchema,
  checkEmailExistsSchema,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { env } from '../config/env';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), register);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/refresh', refreshToken);
router.post('/logout', authenticate, logout);
router.get('/me', authenticate, me);

router.post('/google', authLimiter, validate(googleMobileSchema), googleMobileLogin);
router.post('/google/mobile', authLimiter, validate(googleMobileSchema), googleMobileLogin);

// Firebase Auth hybrid: client supplies a Firebase ID token, we verify it
// and mint our own JWT pair. Same rate limiter as the password endpoint.
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

if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  router.get(
    '/google/web',
    passport.authenticate('google', { scope: ['profile', 'email'], session: false }),
  );
  router.get(
    '/google/web/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login' }),
    googleCallback,
  );
}

export default router;
