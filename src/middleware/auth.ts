import { Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';
import { User } from '../models/User';
import { AuthRequest, UserRole } from '../types';

export const authenticate = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Access token required');
    }

    const token = header.split(' ')[1];
    if (!token) throw ApiError.unauthorized('Access token required');

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw ApiError.unauthorized('Invalid or expired access token');
    }

    // Strict mode: guest tokens are rejected here so endpoints opt-in to
    // guest access via `authenticateOrGuest`. Avoids accidentally treating
    // a guest as a real user on a protected route.
    if (payload.role === 'guest') {
      throw ApiError.forbidden('Sign in with a full account to use this feature');
    }

    const user = await User.findById(payload.userId).select('email role subscription');
    if (!user) throw ApiError.unauthorized('User not found');

    req.user = {
      _id: user._id,
      id: user._id.toString(),
      email: user.email,
      role: user.role,
      subscription: user.subscription.tier,
    };

    next();
  } catch (err) {
    next(err);
  }
};

// Like `authenticate`, but also accepts guest tokens (role: 'guest') issued
// by `POST /auth/guest`. For guests we skip the DB lookup since there is no
// User document — `req.user` is built from the JWT claims alone. Use this
// on endpoints where guests should get a degraded but functional response
// (e.g. matched feed falls back to public listings).
export const authenticateOrGuest = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Access token required');
    }

    const token = header.split(' ')[1];
    if (!token) throw ApiError.unauthorized('Access token required');

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw ApiError.unauthorized('Invalid or expired access token');
    }

    if (payload.role === 'guest') {
      req.user = {
        id: payload.userId,
        email: payload.email,
        role: 'guest',
        subscription: 'free',
      };
      return next();
    }

    const user = await User.findById(payload.userId).select('email role subscription');
    if (!user) throw ApiError.unauthorized('User not found');

    req.user = {
      _id: user._id,
      id: user._id.toString(),
      email: user.email,
      role: user.role,
      subscription: user.subscription.tier,
    };
    next();
  } catch (err) {
    next(err);
  }
};

export const optionalAuth = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return next();

    const token = header.split(' ')[1];
    const payload = verifyAccessToken(token);

    if (payload.role === 'guest') {
      req.user = {
        id: payload.userId,
        email: payload.email,
        role: 'guest',
        subscription: 'free',
      };
      return next();
    }

    const user = await User.findById(payload.userId).select('email role subscription');
    if (user) {
      req.user = {
        _id: user._id,
        id: user._id.toString(),
        email: user.email,
        role: user.role,
        subscription: user.subscription.tier,
      };
    }
    next();
  } catch {
    next();
  }
};

export const authorize =
  (...roles: Array<UserRole>) =>
  (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden('Insufficient permissions'));
    next();
  };
