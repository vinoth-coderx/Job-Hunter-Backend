import { Response } from 'express';
import { Notification } from '../models/Notification';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

const parsePagination = (q: Record<string, unknown>) => {
  const pageRaw = typeof q.page === 'string' ? Number(q.page) : NaN;
  const limitRaw = typeof q.limit === 'string' ? Number(q.limit) : NaN;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 30);
  return { page, limit, skip: (page - 1) * limit };
};

export const listNotifications = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const q = req.query as Record<string, unknown>;
  const filter: Record<string, unknown> = { user: req.user._id };
  if (typeof q.role === 'string' && (q.role === 'seeker' || q.role === 'hirer')) {
    filter.role = q.role;
  }
  if (q.unread === 'true') filter.isRead = false;

  const { page, limit, skip } = parsePagination(q);
  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: req.user._id, isRead: false }),
  ]);

  res.json({
    success: true,
    data: items,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      unread,
    },
  });
});

export const unreadCount = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const count = await Notification.countDocuments({ user: req.user._id, isRead: false });
  res.json({ success: true, data: { unread: count } });
});

export const markRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid notification id');

  const result = await Notification.updateOne(
    { _id: id, user: req.user._id, isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
  );
  res.json({ success: true, data: { modified: result.modifiedCount } });
});

export const markAllRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const result = await Notification.updateMany(
    { user: req.user._id, isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
  );
  res.json({ success: true, data: { modified: result.modifiedCount } });
});

export const deleteNotification = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid notification id');

  await Notification.deleteOne({ _id: id, user: req.user._id });
  res.json({ success: true });
});
