"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendToTokens = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const env_1 = require("../../config/env");
const logger_1 = require("../../utils/logger");
let adminApp = null;
let initAttempted = false;
const loadServiceAccount = () => {
    if (env_1.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        try {
            return JSON.parse(env_1.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        }
        catch (err) {
            logger_1.logger.error('FCM: invalid FIREBASE_SERVICE_ACCOUNT_JSON', err);
            return null;
        }
    }
    if (env_1.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        try {
            const raw = node_fs_1.default.readFileSync(env_1.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8');
            return JSON.parse(raw);
        }
        catch (err) {
            logger_1.logger.error('FCM: failed to read FIREBASE_SERVICE_ACCOUNT_PATH', err);
            return null;
        }
    }
    return null;
};
const getAdmin = async () => {
    if (initAttempted) {
        return adminApp ? (await Promise.resolve().then(() => __importStar(require('firebase-admin')))).default : null;
    }
    initAttempted = true;
    const credentials = loadServiceAccount();
    if (!credentials) {
        logger_1.logger.info('FCM: no service-account configured — push delivery disabled');
        return null;
    }
    try {
        const admin = (await Promise.resolve().then(() => __importStar(require('firebase-admin')))).default;
        adminApp = admin.initializeApp({
            credential: admin.credential.cert(credentials),
            projectId: env_1.env.FIREBASE_PROJECT_ID,
        });
        logger_1.logger.info('FCM: firebase-admin initialised');
        return admin;
    }
    catch (err) {
        logger_1.logger.error('FCM: firebase-admin init failed', err);
        return null;
    }
};
const sendToTokens = async (tokens, payload) => {
    if (tokens.length === 0)
        return { successCount: 0, failureCount: 0 };
    const admin = await getAdmin();
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
