import { Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { ApiError } from '../utils/ApiError';
import { User } from '../models/User';
import { AuthRequest } from '../types';

export const authenticate = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Missing or invalid Authorization header');
    }

    const token = header.split(' ')[1];
    const payload = verifyAccessToken(token);

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
  (...roles: Array<'user' | 'admin'>) =>
  (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden('Insufficient permissions'));
    next();
  };
