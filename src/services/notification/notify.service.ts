import mongoose from 'mongoose';
import { Notification, INotification } from '../../models/Notification';
import { DeviceToken } from '../../models/DeviceToken';
import { User } from '../../models/User';
import { NotificationType } from '../../types';
import { emitToUser } from '../chat/socket';
import { logger } from '../../utils/logger';
import { sendToTokens } from './fcm.service';

interface NotifyParams {
  user: mongoose.Types.ObjectId | string;
  role: 'seeker' | 'hirer';
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/// Persist a notification, fan it out to any connected sockets, AND
/// fire an FCM push to the user's registered devices so the OS shows a
/// system-tray notification when the app is backgrounded / killed.
///
/// Callers should use this in place of `Notification.create` so the
/// inbox + the live banner + the push notification stay in sync —
/// otherwise the user has to pull-to-refresh to discover what just
/// happened.
///
/// Push is gated by `notificationPreferences.push` (default on). FCM is
/// best-effort and never throws — token cleanup of "not registered"
/// tokens runs after each send so dead devices stop receiving.
///
/// Emits `notification:new` over Socket.IO with the saved doc as
/// payload; the client listens and prepends without a fetch.
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

  // Push fan-out. Run in parallel with the function's resolve so the
  // caller (HTTP handler) doesn't block on FCM. Errors are logged and
  // swallowed — push is best-effort.
  void sendPushFor(doc).catch((err) => {
    logger.warn(`notifyUser push failed: ${(err as Error).message}`);
  });

  return doc;
};

/// FCM dispatcher. Loads the user's preferences + device tokens, sends
/// a multicast, and prunes any tokens FCM rejected as invalid.
const sendPushFor = async (doc: INotification): Promise<void> => {
  const userId = doc.user.toString();

  const user = await User.findById(userId)
    .select('notificationPreferences')
    .lean();
  if (!user) return;

  const prefs = user.notificationPreferences ?? { push: true };
  if (prefs.push === false) return;

  const tokens = await DeviceToken.find({ user: userId }).select('token');
  const tokenStrs = tokens.map((t) => t.token).filter(Boolean);
  if (tokenStrs.length === 0) return;

  // Stringify everything in `data` — FCM's data payload is a string map,
  // and the Flutter side decodes it back. Always include `type` so the
  // tap-to-navigate logic on the client can route to the right screen.
  const dataPayload: Record<string, string> = { type: String(doc.type) };
  if (doc.data && typeof doc.data === 'object') {
    for (const [k, v] of Object.entries(doc.data as Record<string, unknown>)) {
      if (v == null) continue;
      dataPayload[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }

  const result = await sendToTokens(tokenStrs, {
    title: doc.title,
    body: doc.body,
    data: dataPayload,
  });

  if (result.invalidTokens && result.invalidTokens.length > 0) {
    await DeviceToken.deleteMany({ token: { $in: result.invalidTokens } });
  }
};
