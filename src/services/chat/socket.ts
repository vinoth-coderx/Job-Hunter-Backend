import http from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { verifyAccessToken } from '../../utils/jwt';
import { logger } from '../../utils/logger';

let io: SocketIOServer | null = null;

// userId → set of socket ids. A user can have multiple devices/tabs open;
// emits go to all sockets registered for the user.
const userSockets = new Map<string, Set<string>>();

interface AuthedSocket extends Socket {
  userId?: string;
}

const registerSocket = (userId: string, socketId: string) => {
  let set = userSockets.get(userId);
  if (!set) {
    set = new Set();
    userSockets.set(userId, set);
  }
  set.add(socketId);
};

const unregisterSocket = (userId: string, socketId: string) => {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) userSockets.delete(userId);
};

/**
 * Attach a Socket.IO server to the existing HTTP server. Must be called
 * once at startup, after `connectDatabase` etc.
 *
 * Auth: clients must connect with `auth: { token }` containing a valid
 * access token. We reject the connection otherwise so unauth'd sockets
 * never enter the connected state.
 */
export const initSocket = (server: http.Server): SocketIOServer => {
  if (io) return io;

  io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    // Path stays default `/socket.io` so the Flutter client can use the
    // out-of-the-box socket_io_client config.
  });

  io.use((socket: AuthedSocket, next) => {
    const tokenRaw =
      (socket.handshake.auth?.token as string | undefined) ??
      (socket.handshake.headers?.authorization?.toString().replace(/^Bearer\s+/i, ''));
    if (!tokenRaw) return next(new Error('Auth token required'));

    try {
      const payload = verifyAccessToken(tokenRaw);
      if (payload.role === 'guest') return next(new Error('Guests cannot connect to chat'));
      socket.userId = payload.userId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: AuthedSocket) => {
    const uid = socket.userId;
    if (!uid) {
      socket.disconnect(true);
      return;
    }
    registerSocket(uid, socket.id);
    logger.debug(`[chat] connected user=${uid} socket=${socket.id}`);

    socket.on('typing:start', (payload: { conversationId?: string; otherUserId?: string }) => {
      if (!payload?.otherUserId) return;
      emitToUser(payload.otherUserId, 'typing:start', {
        conversationId: payload.conversationId,
        userId: uid,
      });
    });

    socket.on('typing:stop', (payload: { conversationId?: string; otherUserId?: string }) => {
      if (!payload?.otherUserId) return;
      emitToUser(payload.otherUserId, 'typing:stop', {
        conversationId: payload.conversationId,
        userId: uid,
      });
    });

    socket.on('disconnect', () => {
      unregisterSocket(uid, socket.id);
      logger.debug(`[chat] disconnected user=${uid} socket=${socket.id}`);
    });
  });

  logger.info('Socket.IO server attached on path /socket.io');
  return io;
};

/**
 * Emit an event to every active socket registered for this user.
 * Used by the REST controller to fan out a freshly-saved message to
 * both participants in real time.
 */
export const emitToUser = (
  userId: string,
  event: string,
  payload: unknown,
): void => {
  if (!io) return;
  const set = userSockets.get(userId);
  if (!set) return;
  for (const sid of set) {
    io.to(sid).emit(event, payload);
  }
};

export const closeSocket = async (): Promise<void> => {
  if (!io) return;
  await new Promise<void>((resolve) => io!.close(() => resolve()));
  io = null;
};
