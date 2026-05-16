import { Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { User, IUser } from '../models/User';
import { UserSession } from '../models/UserSession';
import { SecurityEvent } from '../models/SecurityEvent';
import { listActiveSessions } from '../services/security/session.service';

type UserDoc = Pick<
  IUser,
  | '_id'
  | 'email'
  | 'activeRole'
  | 'isAdmin'
  | 'isBanned'
  | 'bannedAt'
  | 'banReason'
  | 'isEmailVerified'
  | 'isPhoneVerified'
  | 'profile'
  | 'subscription'
  | 'twoFactor'
  | 'security'
  | 'privacy'
  | 'lastLogin'
  | 'createdAt'
>;

/** Server → admin-UI mapping. Admin role is computed from isAdmin so the
 * UI's "Role" column reflects platform privilege rather than the seeker/
 * hirer mode the user is currently in.
 */
const toAdminUser = (u: UserDoc) => ({
  _id: u._id.toString(),
  email: u.email,
  activeRole: u.isAdmin ? 'admin' : u.activeRole,
  isEmailVerified: u.isEmailVerified,
  isPhoneVerified: u.isPhoneVerified ?? false,
  isBanned: u.isBanned,
  banReason: u.banReason,
  profile: {
    fullName: u.profile?.fullName ?? '',
    avatarUrl: u.profile?.avatar,
    phone: u.profile?.phone,
  },
  subscription: {
    tier: u.subscription?.tier ?? 'free',
    status: u.subscription?.status ?? 'active',
    endDate: u.subscription?.endDate?.toISOString(),
  },
  twoFactor: u.twoFactor
    ? {
        enabled: u.twoFactor.enabled ?? false,
        method: u.twoFactor.method,
        enrolledAt: u.twoFactor.enrolledAt?.toISOString(),
      }
    : { enabled: false },
  security: u.security
    ? {
        trustScore: u.security.trustScore,
        failedLoginCount: u.security.failedLoginCount,
        lockedUntil: u.security.lockedUntil?.toISOString(),
        lastSeenIp: u.security.lastSeenIp,
      }
    : undefined,
  privacy: u.privacy
    ? {
        openToWork: u.privacy.openToWork,
        resumeVisibility: u.privacy.resumeVisibility,
      }
    : undefined,
  createdAt: u.createdAt.toISOString(),
  lastSeenAt: u.lastLogin?.toISOString(),
});

const SELECT_FIELDS =
  'email activeRole isAdmin isBanned bannedAt banReason isEmailVerified isPhoneVerified profile.fullName profile.avatar profile.phone subscription twoFactor.enabled twoFactor.method twoFactor.enrolledAt security.trustScore security.failedLoginCount security.lockedUntil security.lastSeenIp privacy.openToWork privacy.resumeVisibility lastLogin createdAt';

export const listUsers = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const q = (req.query.q as string | undefined)?.trim();
    const role = (req.query.role as string | undefined) ?? 'all';
    const status = (req.query.status as string | undefined) ?? 'all';
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const perPage = Math.min(
      100,
      Math.max(1, parseInt(req.query.perPage as string, 10) || 20),
    );

    const filter: Record<string, unknown> = {};

    if (q) {
      filter.$or = [
        { email: { $regex: q, $options: 'i' } },
        { 'profile.fullName': { $regex: q, $options: 'i' } },
      ];
    }

    if (role === 'admin') {
      filter.isAdmin = true;
    } else if (role === 'seeker' || role === 'hirer') {
      filter.activeRole = role;
      filter.isAdmin = { $ne: true };
    }

    if (status === 'banned') filter.isBanned = true;
    else if (status === 'verified') filter.isEmailVerified = true;
    else if (status === 'unverified') filter.isEmailVerified = false;

    const [users, total] = await Promise.all([
      User.find(filter)
        .select(SELECT_FIELDS)
        .sort({ createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage)
        .lean<UserDoc[]>(),
      User.countDocuments(filter),
    ]);

    res.json({
      users: users.map(toAdminUser),
      total,
      page,
      perPage,
    });
  },
);

export const userStats = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalSeekers,
      totalHirers,
      totalAdmins,
      totalVerified,
      totalBanned,
      newToday,
      newThisWeek,
      activeToday,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ activeRole: 'seeker', isAdmin: { $ne: true } }),
      User.countDocuments({ activeRole: 'hirer', isAdmin: { $ne: true } }),
      User.countDocuments({ isAdmin: true }),
      User.countDocuments({ isEmailVerified: true }),
      User.countDocuments({ isBanned: true }),
      User.countDocuments({ createdAt: { $gte: startOfToday } }),
      User.countDocuments({ createdAt: { $gte: startOfWeek } }),
      // "Active today" = had at least one login since yesterday's start.
      User.countDocuments({ lastLogin: { $gte: startOfYesterday } }),
    ]);

    res.json({
      totalUsers,
      totalSeekers,
      totalHirers,
      totalAdmins,
      totalVerified,
      totalBanned,
      newToday,
      newThisWeek,
      activeToday,
    });
  },
);

const requireObjectId = (id: unknown): Types.ObjectId => {
  if (typeof id !== 'string' || !Types.ObjectId.isValid(id)) {
    throw ApiError.badRequest('Invalid user id');
  }
  return new Types.ObjectId(id);
};

export const getUser = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = requireObjectId(req.params.id);
    const u = await User.findById(id).select(SELECT_FIELDS).lean<UserDoc>();
    if (!u) throw ApiError.notFound('User not found');
    res.json(toAdminUser(u));
  },
);

export const updateUser = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = requireObjectId(req.params.id);
    const { fullName, activeRole, isEmailVerified } = req.body ?? {};

    const update: Record<string, unknown> = {};
    if (typeof fullName === 'string') {
      update['profile.fullName'] = fullName.trim();
    }
    if (typeof isEmailVerified === 'boolean') {
      update.isEmailVerified = isEmailVerified;
    }
    if (activeRole === 'admin') {
      update.isAdmin = true;
    } else if (activeRole === 'seeker' || activeRole === 'hirer') {
      update.activeRole = activeRole;
      update.isAdmin = false;
    } else if (activeRole !== undefined) {
      throw ApiError.badRequest(
        'activeRole must be one of seeker | hirer | admin',
      );
    }

    if (Object.keys(update).length === 0) {
      throw ApiError.badRequest('No updatable fields supplied');
    }

    // Prevent an admin from un-admining themselves and losing the floor.
    if (req.user?.id === id.toString() && update.isAdmin === false) {
      throw ApiError.badRequest(
        "You can't remove your own admin role — promote another user first.",
      );
    }

    const updated = await User.findByIdAndUpdate(id, update, {
      new: true,
    })
      .select(SELECT_FIELDS)
      .lean<UserDoc>();
    if (!updated) throw ApiError.notFound('User not found');
    res.json(toAdminUser(updated));
  },
);

export const banUser = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = requireObjectId(req.params.id);
    if (req.user?.id === id.toString()) {
      throw ApiError.badRequest("You can't ban your own account.");
    }
    const reason =
      typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined;
    const updated = await User.findByIdAndUpdate(
      id,
      {
        isBanned: true,
        bannedAt: new Date(),
        banReason: reason,
        $unset: { refreshTokens: '' },
      },
      { new: true },
    )
      .select(SELECT_FIELDS)
      .lean<UserDoc>();
    if (!updated) throw ApiError.notFound('User not found');
    res.json(toAdminUser(updated));
  },
);

export const unbanUser = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = requireObjectId(req.params.id);
    const updated = await User.findByIdAndUpdate(
      id,
      {
        isBanned: false,
        $unset: { bannedAt: '', banReason: '' },
      },
      { new: true },
    )
      .select(SELECT_FIELDS)
      .lean<UserDoc>();
    if (!updated) throw ApiError.notFound('User not found');
    res.json(toAdminUser(updated));
  },
);

/// Trust panel sidecar — sessions + recent security events for a single
/// user. Surfaced on the admin user-detail page so a reviewer can see
/// the full session/IP/device picture before banning or unbanning.
export const getUserTrust = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = requireObjectId(req.params.id);
    const [sessions, recentEvents, sessionCount] = await Promise.all([
      listActiveSessions(id),
      SecurityEvent.find({ user: id })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      UserSession.countDocuments({ user: id }),
    ]);
    res.json({
      sessions,
      sessionCount,
      recentEvents,
    });
  },
);
