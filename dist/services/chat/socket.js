"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeSocket = exports.emitToUser = exports.initSocket = void 0;
const socket_io_1 = require("socket.io");
const jwt_1 = require("../../utils/jwt");
const logger_1 = require("../../utils/logger");
let io = null;
const userSockets = new Map();
const registerSocket = (userId, socketId) => {
    let set = userSockets.get(userId);
    if (!set) {
        set = new Set();
        userSockets.set(userId, set);
    }
    set.add(socketId);
};
const unregisterSocket = (userId, socketId) => {
    const set = userSockets.get(userId);
    if (!set)
        return;
    set.delete(socketId);
    if (set.size === 0)
        userSockets.delete(userId);
};
const initSocket = (server) => {
    if (io)
        return io;
    io = new socket_io_1.Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
    });
    io.use((socket, next) => {
        const tokenRaw = socket.handshake.auth?.token ??
            (socket.handshake.headers?.authorization?.toString().replace(/^Bearer\s+/i, ''));
        if (!tokenRaw)
            return next(new Error('Auth token required'));
        try {
            const payload = (0, jwt_1.verifyAccessToken)(tokenRaw);
            if (payload.role === 'guest')
                return next(new Error('Guests cannot connect to chat'));
            socket.userId = payload.userId;
            next();
        }
        catch {
            next(new Error('Invalid token'));
        }
    });
    io.on('connection', (socket) => {
        const uid = socket.userId;
        if (!uid) {
            socket.disconnect(true);
            return;
        }
        registerSocket(uid, socket.id);
        logger_1.logger.debug(`[chat] connected user=${uid} socket=${socket.id}`);
        socket.on('typing:start', (payload) => {
            if (!payload?.otherUserId)
                return;
            (0, exports.emitToUser)(payload.otherUserId, 'typing:start', {
                conversationId: payload.conversationId,
                userId: uid,
            });
        });
        socket.on('typing:stop', (payload) => {
            if (!payload?.otherUserId)
                return;
            (0, exports.emitToUser)(payload.otherUserId, 'typing:stop', {
                conversationId: payload.conversationId,
                userId: uid,
            });
        });
        socket.on('disconnect', () => {
            unregisterSocket(uid, socket.id);
            logger_1.logger.debug(`[chat] disconnected user=${uid} socket=${socket.id}`);
        });
    });
    logger_1.logger.info('Socket.IO server attached on path /socket.io');
    return io;
};
exports.initSocket = initSocket;
const emitToUser = (userId, event, payload) => {
    if (!io)
        return;
    const set = userSockets.get(userId);
    if (!set)
        return;
    for (const sid of set) {
        io.to(sid).emit(event, payload);
    }
};
exports.emitToUser = emitToUser;
const closeSocket = async () => {
    if (!io)
        return;
    await new Promise((resolve) => io.close(() => resolve()));
    io = null;
};
exports.closeSocket = closeSocket;
