"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendToTokens = void 0;
const logger_1 = require("../../utils/logger");
const admin_service_1 = require("../firebase/admin.service");
const sendToTokens = async (tokens, payload) => {
    if (tokens.length === 0)
        return { successCount: 0, failureCount: 0 };
    const admin = await (0, admin_service_1.getFirebaseAdmin)();
    if (!admin)
        return { skipped: true };
    try {
        const response = await admin.messaging().sendEachForMulticast({
            tokens,
            notification: { title: payload.title, body: payload.body },
            data: payload.data ?? {},
            android: {
                priority: 'high',
                notification: { channelId: 'job_alerts' },
            },
            apns: {
                payload: {
                    aps: { sound: 'default' },
                },
            },
        });
        const invalidTokens = [];
        response.responses.forEach((r, i) => {
            if (!r.success) {
                const code = r.error?.code ?? '';
                if (code === 'messaging/registration-token-not-registered' ||
                    code === 'messaging/invalid-registration-token') {
                    invalidTokens.push(tokens[i]);
                }
            }
        });
        return {
            successCount: response.successCount,
            failureCount: response.failureCount,
            invalidTokens,
        };
    }
    catch (err) {
        logger_1.logger.error('FCM: sendEachForMulticast failed', err);
        return { skipped: true };
    }
};
exports.sendToTokens = sendToTokens;
