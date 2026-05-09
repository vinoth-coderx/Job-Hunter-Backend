import mongoose from 'mongoose';
import { Notification, INotification } from '../../models/Notification';
import { NotificationType } from '../../types';
import { emitToUser } from '../chat/socket';

interface NotifyParams {
  user: mongoose.Types.ObjectId | string;
  role: 'seeker' | 'hirer';
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/// Persist a notification AND fan it out to any connected sockets for the
/// recipient. Callers should use this in place of `Notification.create`
/// so the inbox + the live banner stay in sync — otherwise the user has
/// to pull-to-refresh to discover what just happened.
///
/// Emits `notification:new` over Socket.IO with the saved doc as payload;
/// the client listens and prepends without a fetch.
export const notifyUser = async (params: NotifyParams): Promise<INotification> => {
  const doc = await Notification.create({
    user: params.user,
    role: params.role,
    type: params.type,
    title: params.title,
    body: params.body,
    data: params.data,
  });

  emitToUser(doc.user.toString(), 'notification:new', {
    id: doc._id.toString(),
    type: doc.type,
    title: doc.title,
    body: doc.body,
    data: doc.data,
    isRead: doc.isRead,
    createdAt: doc.createdAt,
  });

  return doc;
};
