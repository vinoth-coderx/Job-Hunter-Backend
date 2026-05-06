import { Request, Response } from 'express';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { generateTokenPair, verifyRefreshToken } from '../utils/jwt';
import { asyncHandler } from '../utils/asyncHandler';
import { AuthRequest } from '../types';
import { logger } from '../utils/logger';
import { randomToken } from '../utils/crypto';
import { recordFailedLogin, isLockedOut, clearFailedLogins } from '../middleware/security';
import { env } from '../config/env';

const googleAudiences = [
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_ANDROID_CLIENT_ID,
  env.GOOGLE_IOS_CLIENT_ID,
].filter((id): id is string => Boolean(id));

const googleClient = new OAuth2Client();

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
      profile: user.profile,
      subscription: user.subscription,
      isEmailVerified: user.isEmailVerified,
      createdAt: user.createdAt,
    },
  });
});

export const googleCallback = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as { _id: { toString: () => string }; email: string; role: 'user' | 'admin' } | undefined;
  if (!user) throw ApiError.unauthorized('Google authentication failed');

  const tokens = generateTokenPair({
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
  });

  const dbUser = await User.findById(user._id).select('+refreshTokens');
  if (dbUser) {
    dbUser.refreshTokens = [...(dbUser.refreshTokens || []).slice(-4), tokens.refreshToken];
    dbUser.lastLogin = new Date();
    await dbUser.save();
  }

  res.json({
    success: true,
    message: 'Google login successful',
    data: { ...tokens },
  });
});

export const googleMobileSchema = z.object({
  body: z.object({
    idToken: z.string().min(20),
    platform: z.enum(['android', 'ios', 'web']).optional(),
  }),
});

export const googleMobileLogin = asyncHandler(async (req: Request, res: Response) => {
  if (!googleAudiences.length) {
    throw ApiError.internal('Google login not configured (set GOOGLE_CLIENT_ID/ANDROID_CLIENT_ID/IOS_CLIENT_ID)');
  }

  const { idToken } = req.body as { idToken: string };

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: googleAudiences,
    });
    payload = ticket.getPayload();
  } catch (err) {
    logger.warn('Invalid Google ID token', err);
    throw ApiError.unauthorized('Invalid Google ID token');
  }

  if (!payload) throw ApiError.unauthorized('Empty Google token payload');
  if (!payload.email) throw ApiError.unauthorized('Google account has no email');
  if (payload.email_verified === false) throw ApiError.unauthorized('Google email not verified');

  const email = payload.email.toLowerCase();
  let user = await User.findOne({ $or: [{ googleId: payload.sub }, { email }] }).select('+refreshTokens');

  if (!user) {
    user = await User.create({
      email,
      googleId: payload.sub,
      authProvider: 'google',
      isEmailVerified: true,
      profile: {
        fullName: payload.name || email.split('@')[0],
        avatar: payload.picture,
        skills: [],
        experienceYears: 0,
        preferredRoles: [],
        preferredLocations: [],
        preferredJobTypes: [],
        preferredRemote: [],
      },
      subscription: { tier: 'free', status: 'active' },
    });
  } else if (!user.googleId) {
    user.googleId = payload.sub;
    user.isEmailVerified = true;
    if (!user.profile.avatar && payload.picture) user.profile.avatar = payload.picture;
    await user.save();
  }

  const tokens = generateTokenPair({
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
  });

  user.refreshTokens = [...(user.refreshTokens || []).slice(-4), tokens.refreshToken];
  user.lastLogin = new Date();
  await user.save();

  logger.info(`Google mobile login: ${email}`);

  res.json({
    success: true,
    message: 'Google login successful',
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
