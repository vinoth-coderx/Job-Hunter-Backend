"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopTrustMaintenanceCron = exports.startTrustMaintenanceCron = exports.runTrustMaintenanceNow = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const logger_1 = require("../utils/logger");
const cronTracker_1 = require("../utils/cronTracker");
const config_service_1 = require("../services/config/config.service");
const HirerProfile_1 = require("../models/HirerProfile");
const trustScore_service_1 = require("../services/security/trustScore.service");
const session_service_1 = require("../services/security/session.service");
const Verification_1 = require("../models/Verification");
const cronsEnabled = () => (0, config_service_1.getAppConfig)('CRON_ENABLED') !== 'false';
let task = null;
let isRunning = false;
const runTrustMaintenanceNow = async () => {
    const hirers = await HirerProfile_1.HirerProfile.find().select('user').lean();
    let updated = 0;
    for (const h of hirers) {
        try {
            await (0, trustScore_service_1.recomputeHirerTrust)(h.user);
            updated += 1;
        }
        catch (err) {
            logger_1.logger.warn(`[trustMaintenance] failed for ${h.user}: ${err.message}`);
        }
    }
    const sweptSessions = await (0, session_service_1.sweepInactiveSessions)();
    const expiryCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const expired = await Verification_1.Verification.updateMany({ status: 'pending', createdAt: { $lt: expiryCutoff } }, { $set: { status: 'expired' } });
    logger_1.logger.info(`[trustMaintenance] recomputed ${updated}/${hirers.length} hirers, swept ${sweptSessions} sessions, expired ${expired.modifiedCount ?? 0} verifications`);
};
exports.runTrustMaintenanceNow = runTrustMaintenanceNow;
const startTrustMaintenanceCron = () => {
    if (!cronsEnabled())
        return;
    const schedule = (0, cronTracker_1.getCronSchedule)('trustMaintenance');
    if (!node_cron_1.default.validate(schedule)) {
        logger_1.logger.error(`Invalid trustMaintenance cron expression: ${schedule}`);
        return;
    }
    task = node_cron_1.default.schedule(schedule, (0, cronTracker_1.trackedCron)('trustMaintenance', async () => {
        if (isRunning) {
            logger_1.logger.warn('trustMaintenance: previous tick still running — skipping');
            return;
        }
        isRunning = true;
        const start = Date.now();
        try {
            await (0, exports.runTrustMaintenanceNow)();
            logger_1.logger.info(`trustMaintenance: tick complete in ${Date.now() - start}ms`);
        }
        finally {
            isRunning = false;
        }
    }), { timezone: 'Asia/Kolkata' });
    logger_1.logger.info(`trustMaintenance cron scheduled: "${schedule}"`);
};
exports.startTrustMaintenanceCron = startTrustMaintenanceCron;
const stopTrustMaintenanceCron = () => {
    if (task) {
        task.stop();
        task = null;
    }
};
exports.stopTrustMaintenanceCron = stopTrustMaintenanceCron;
