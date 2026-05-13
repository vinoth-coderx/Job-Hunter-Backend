import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';

/**
 * Gate for /api/v1/admin/*. Runs AFTER `authenticate`, so it can trust
 * `req.user.id` exists and corresponds to a non-guest, non-banned account.
 *
 * The admin flag lives on the User document (not the JWT) so a fresh
 * promotion takes effect on the next request without forcing the user
 * to re-login. The cost is one indexed `findById` per request — fine
 * for an internal-traffic admin console.
 */
export const requireAdmin = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user?.id) {
      throw ApiError.unauthorized('Authentication required');
    }
    const me = await User.findById(req.user.id).select('isAdmin isBanned').lean();
    if (!me) throw ApiError.unauthorized('User not found');
    if (me.isBanned) throw ApiError.forbidden('Account suspended');
    if (!me.isAdmin) throw ApiError.forbidden('Admin access required');
    next();
  } catch (err) {
    next(err);
  }
};
