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
exports.resetFirebaseAdmin = exports.isFirebaseConfigured = exports.getFirebaseAdmin = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const config_service_1 = require("../config/config.service");
const logger_1 = require("../../utils/logger");
let cached = null;
let initAttempted = false;
const loadServiceAccount = () => {
    const jsonBlob = (0, config_service_1.getAppConfig)('FIREBASE_SERVICE_ACCOUNT_JSON');
    if (jsonBlob) {
        try {
            return JSON.parse(jsonBlob);
        }
        catch (err) {
            logger_1.logger.error('firebase-admin: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON', err);
            return null;
        }
    }
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (path) {
        try {
            const raw = node_fs_1.default.readFileSync(path, 'utf8');
            return JSON.parse(raw);
        }
        catch (err) {
            logger_1.logger.error('firebase-admin: failed to read FIREBASE_SERVICE_ACCOUNT_PATH', err);
            return null;
        }
    }
    return null;
};
const getFirebaseAdmin = async () => {
    if (cached)
        return cached;
    if (initAttempted)
        return null;
    initAttempted = true;
    const credentials = loadServiceAccount();
    if (!credentials) {
        logger_1.logger.info('firebase-admin: no service-account configured — Firebase features disabled');
        return null;
    }
    try {
        const admin = (await Promise.resolve().then(() => __importStar(require('firebase-admin')))).default;
        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert(credentials),
                projectId: (0, config_service_1.getAppConfig)('FIREBASE_PROJECT_ID') ?? undefined,
            });
            logger_1.logger.info('firebase-admin initialised');
        }
        cached = admin;
        return admin;
    }
    catch (err) {
        logger_1.logger.error('firebase-admin init failed', err);
        return null;
    }
};
exports.getFirebaseAdmin = getFirebaseAdmin;
const isFirebaseConfigured = () => Boolean((0, config_service_1.getAppConfig)('FIREBASE_SERVICE_ACCOUNT_JSON')) ||
    Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
exports.isFirebaseConfigured = isFirebaseConfigured;
const resetFirebaseAdmin = async () => {
    if (cached) {
        try {
            await Promise.all(cached.apps.map((app) => app?.delete()));
        }
        catch (err) {
            logger_1.logger.warn('firebase-admin: app.delete() failed during reset', err);
        }
    }
    cached = null;
    initAttempted = false;
};
exports.resetFirebaseAdmin = resetFirebaseAdmin;
