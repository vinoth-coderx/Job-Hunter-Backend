import { Request, Response } from 'express';
import { z } from 'zod';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { generateTokenPair, generateGuestAccessToken, verifyRefreshToken } from '../utils/jwt';
import { randomUUID } from 'crypto';
import { asyncHandler } from '../utils/asyncHandler';
import { AuthRequest } from '../types';
import { logger } from '../utils/logger';
import { randomToken } from '../utils/crypto';
import { recordFailedLogin, isLockedOut, clearFailedLogins } from '../middleware/security';
import { getFirebaseAdmin } from '../services/firebase/admin.service';

const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(100)
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[0-9]/, 'Password must contain a number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain a special character');

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email().max(254),
    password: strongPassword,
    fullName: z.string().min(2).max(100),
    phone: z.string().max(20).optional(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
});

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { email, password, fullName, phone } = req.body;

  const existing = await User.findOne({ email });
  if (existing) throw ApiError.conflict('Email already registered');

  const verificationToken = randomToken(32);

  const user = await User.create({
    email,
    password,
    authProvider: 'local',
    isEmailVerified: false,
    emailVerificationToken: verificationToken,
    profile: {
      fullName,
      phone,
      skills: [],
      experienceYears: 0,
      preferredRoles: [],
      preferredLocations: [],
      preferredJobTypes: [],
      preferredRemote: [],
    },
    subscription: { tier: 'free', status: 'active' },
  });

  const tokens = generateTokenPair({
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
  });

  user.refreshTokens = [tokens.refreshToken];
  await user.save();

  logger.info(`New user registered: ${email}`);

  res.status(201).json({
    success: true,
    message: 'Registered successfully',
    data: {
      user: {
        id: user._id,
        email: user.email,
        fullName: user.profile.fullName,
        role: user.role,
        subscription: user.subscription,
      },
      ...tokens,
    },
  });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const lockKey = `${email}:${ip}`;

  if (await isLockedOut(lockKey)) {
    throw ApiError.tooMany('Too many failed attempts. Try again in 30 minutes.');
  }

  const user = await User.findOne({ email }).select('+password +refreshTokens');
  if (!user) {
    await recordFailedLogin(lockKey);
    throw ApiError.unauthorized('Invalid email or password');
  }

  if (user.authProvider === 'google' && !user.password) {
    throw ApiError.badRequest('Use Google login for this account');
  }

  const valid = await user.comparePassword(password);
  if (!valid) {
    const { locked } = await recordFailedLogin(lockKey);
    if (locked) logger.warn(`Account locked: ${email} from ${ip}`);
    throw ApiError.unauthorized('Invalid email or password');
  }

  await clearFailedLogins(lockKey);

  const tokens = generateTokenPair({
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
  });

  user.refreshTokens = [...(user.refreshTokens || []).slice(-4), tokens.refreshToken];
  user.lastLogin = new Date();
  await user.save();

  res.json({
    success: true,
    message: 'Logged in successfully',
    data: {
      user: {
        id: user._id,
        email: user.email,
        fullName: user.profile.fullName,
        role: user.role,
        subscription: user.subscription,
      },
      ...tokens,
    },
  });
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken: token } = req.body;
  if (!token) throw ApiError.badRequest('Refresh token required');

  const payload = verifyRefreshToken(token);
  const user = await User.findById(payload.userId).select('+refreshTokens');
  if (!user) throw ApiError.unauthorized('User not found');

  if (!user.refreshTokens?.includes(token)) {
    throw ApiError.unauthorized('Invalid refresh token');
  }

  const tokens = generateTokenPair({
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
  });

  user.refreshTokens = [
    ...user.refreshTokens.filter((t) => t !== token),
    tokens.refreshToken,
  ].slice(-5);
  await user.save();

  res.json({ success: true, data: tokens });
});

export const logout = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { refreshToken: token } = req.body;
  const user = await User.findById(req.user._id).select('+refreshTokens');
  if (user && token) {
    user.refreshTokens = (user.refreshTokens || []).filter((t) => t !== token);
    await user.save();
  }
  res.json({ success: true, message: 'Logged out' });
});

export const me = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound('User not found');
  res.json({
    success: true,
    data: {
      id: user._id,
      email: user.email,
      role: user.role,
      activeRole: user.activeRole,
      profile: user.profile,
      subscription: user.subscription,
      isEmailVerified: user.isEmailVerified,
      createdAt: user.createdAt,
    },
  });
});

// Stateless guest session: no DB record, no refresh token. The client gets
// a short-lived access token whose `role: 'guest'` claim is honoured by the
// `authenticateOrGuest` middleware. Privileged endpoints (apply, profile,
// subscriptions, /auth/me, etc.) keep using strict `authenticate`, which
// rejects guest tokens — the app will see a clear 401/403 there.
export const guestLogin = asyncHandler(async (_req: Request, res: Response) => {
  const guestId = `guest:${randomUUID()}`;
  const accessToken = generateGuestAccessToken({
    userId: guestId,
    email: 'guest@jobhunter.local',
    role: 'guest',
  });

  res.json({
    success: true,
    message: 'Guest session created',
    data: {
      user: {
        id: guestId,
        email: null,
        fullName: 'Guest',
        role: 'guest',
        subscription: { tier: 'free', status: 'active' },
        isGuest: true,
      },
      accessToken,
      // Refresh token deliberately omitted — guest tokens are not refreshable.
      refreshToken: null,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────
// Firebase Auth hybrid login
//
// The client signs in with the Firebase Auth SDK (any provider it
// supports — email/password, Google, phone, …), grabs the ID token via
// `user.getIdToken()`, and POSTs it here. We verify the token with
// firebase-admin, look up or create the matching User document, then
// mint our own JWT pair so the rest of the API stays unchanged.
//
// Existing JWT-based middleware doesn't need to change. /auth/login and
// the password flow keep working for accounts that haven't migrated.
// ─────────────────────────────────────────────────────────────────────

export const firebaseLoginSchema = z.object({
  body: z.object({
    idToken: z.string().min(20),
    fullName: z.string().min(2).max(100).optional(),
    phone: z.string().max(20).optional(),
  }),
});

export const checkEmailExistsSchema = z.object({
  body: z.object({
    email: z.string().email(),
  }),
});

// Firebase enables "email enumeration protection" by default which makes
// sendPasswordResetEmail silently succeed for non-existent accounts. To
// give users honest "no account found" feedback before triggering the
// reset flow, look the email up via firebase-admin and return whether it
// exists. Note: this re-introduces enumeration risk by design.
export const checkEmailExists = asyncHandler(async (req: Request, res: Response) => {
  const admin = await getFirebaseAdmin();
  if (!admin) {
    throw ApiError.internal(
      'Firebase Auth is not configured on the server (set FIREBASE_SERVICE_ACCOUNT_JSON)',
    );
  }

  const email = (req.body.email as string).toLowerCase().trim();

  try {
    await admin.auth().getUserByEmail(email);
    res.json({ success: true, data: { exists: true } });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'auth/user-not-found') {
      res.json({ success: true, data: { exists: false } });
      return;
    }
    logger.warn('checkEmailExists lookup failed', err);
    throw ApiError.internal('Failed to check email');
  }
});

export const firebaseLogin = asyncHandler(async (req: Request, res: Response) => {
  const admin = await getFirebaseAdmin();
  if (!admin) {
    throw ApiError.internal(
      'Firebase Auth is not configured on the server (set FIREBASE_SERVICE_ACCOUNT_JSON)',
    );
  }

  const { idToken, fullName, phone } = req.body as {
    idToken: string;
    fullName?: string;
    phone?: string;
  };

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch (err) {
    logger.warn('Firebase ID token verification failed', err);
    throw ApiError.unauthorized('Invalid Firebase ID token');
  }

  const firebaseUid = decoded.uid;
  const email = decoded.email?.toLowerCase();
  if (!email) {
    throw ApiError.unauthorized('Firebase token has no email — provider must include email scope');
  }

  // Find by firebaseUid first (fast path for returning users), fall back
  // to email so we can link Firebase to a pre-existing local account.
  let user = await User.findOne({
    $or: [{ firebaseUid }, { email }],
  }).select('+refreshTokens');

  if (!user) {
    user = await User.create({
      email,
      firebaseUid,
      authProvider: 'firebase',
      isEmailVerified: decoded.email_verified ?? false,
      profile: {
        fullName: fullName?.trim() || decoded.name || email.split('@')[0],
        phone: phone?.trim(),
        avatar: decoded.picture,
        skills: [],
        experienceYears: 0,
        preferredRoles: [],
        preferredLocations: [],
        preferredJobTypes: [],
        preferredRemote: [],
      },
      subscription: { tier: 'free', status: 'active' },
    });
    logger.info(`New user via Firebase Auth: ${email}`);
  } else if (!user.firebaseUid) {
    // Existing local/google account — link the Firebase UID so future
    // sign-ins take the fast path. Don't overwrite name/avatar fields
    // the user has already personalised.
    user.firebaseUid = firebaseUid;
    if (!user.isEmailVerified && decoded.email_verified) {
      user.isEmailVerified = true;
    }
    if (!user.profile.avatar && decoded.picture) {
      user.profile.avatar = decoded.picture;
    }
    await user.save();
    logger.info(`Linked Firebase UID to existing account: ${email}`);
  }

  const tokens = generateTokenPair({
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
  });

  user.refreshTokens = [...(user.refreshTokens || []).slice(-4), tokens.refreshToken];
  user.lastLogin = new Date();
  await user.save();

  res.json({
    success: true,
    message: 'Firebase login successful',
    data: {
      user: {
        id: user._id,
        email: user.email,
        fullName: user.profile.fullName,
        avatar: user.profile.avatar,
        role: user.role,
        subscription: user.subscription,
      },
      ...tokens,
    },
  });
});
