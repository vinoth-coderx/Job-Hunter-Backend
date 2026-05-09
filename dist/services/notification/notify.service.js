"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyUser = void 0;
const Notification_1 = require("../../models/Notification");
const socket_1 = require("../chat/socket");
const notifyUser = async (params) => {
    const doc = await Notification_1.Notification.create({
        user: params.user,
        role: params.role,
        type: params.type,
        title: params.title,
        body: params.body,
        data: params.data,
    });
    (0, socket_1.emitToUser)(doc.user.toString(), 'notification:new', {
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
exports.notifyUser = notifyUser;
