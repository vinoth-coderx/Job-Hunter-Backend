"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyUser = void 0;
const Notification_1 = require("../../models/Notification");
const DeviceToken_1 = require("../../models/DeviceToken");
const User_1 = require("../../models/User");
const socket_1 = require("../chat/socket");
const logger_1 = require("../../utils/logger");
const fcm_service_1 = require("./fcm.service");
const config_service_1 = require("../config/config.service");
const notificationCopy_service_1 = require("../ai/notificationCopy.service");
const notifyUser = async (params) => {
    let title = params.title;
    let body = params.body;
    if ((0, config_service_1.getAppConfig)('NOTIFICATION_AI_REWRITE') === '1') {
        let userOptedIn = true;
        try {
            const recipient = await User_1.User.findById(params.user)
                .select('notificationPreferences.aiPolish')
                .lean();
            if (recipient?.notificationPreferences?.aiPolish === false) {
                userOptedIn = false;
            }
        }
        catch {
        }
        if (userOptedIn) {
            try {
                const polished = await (0, notificationCopy_service_1.rewriteNotificationCopy)({
                    type: params.type,
                    title,
                    body,
                });
                title = polished.title;
                body = polished.body;
            }
            catch (err) {
                logger_1.logger.warn(`notify rewrite skipped: ${err.message}`);
            }
        }
    }
    const doc = await Notification_1.Notification.create({
        user: params.user,
        role: params.role,
        type: params.type,
        title,
        body,
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
    void sendPushFor(doc).catch((err) => {
        logger_1.logger.warn(`notifyUser push failed: ${err.message}`);
    });
    return doc;
};
exports.notifyUser = notifyUser;
const sendPushFor = async (doc) => {
    const userId = doc.user.toString();
    const user = await User_1.User.findById(userId)
        .select('notificationPreferences')
        .lean();
    if (!user)
        return;
    const prefs = user.notificationPreferences ?? { push: true };
    if (prefs.push === false)
        return;
    const tokens = await DeviceToken_1.DeviceToken.find({ user: userId }).select('token');
    const tokenStrs = tokens.map((t) => t.token).filter(Boolean);
    if (tokenStrs.length === 0)
        return;
    const dataPayload = { type: String(doc.type) };
    if (doc.data && typeof doc.data === 'object') {
        for (const [k, v] of Object.entries(doc.data)) {
            if (v == null)
                continue;
            dataPayload[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
    }
    const result = await (0, fcm_service_1.sendToTokens)(tokenStrs, {
        title: doc.title,
        body: doc.body,
        data: dataPayload,
    });
    if (result.invalidTokens && result.invalidTokens.length > 0) {
        await DeviceToken_1.DeviceToken.deleteMany({ token: { $in: result.invalidTokens } });
    }
};
