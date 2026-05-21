"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopAlertCheckerCron = exports.startAlertCheckerCron = exports.checkAlertsNow = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const config_service_1 = require("../services/config/config.service");
const constants_1 = require("../config/constants");
const cronsEnabled = () => (0, config_service_1.getAppConfig)('CRON_ENABLED') !== 'false';
const logger_1 = require("../utils/logger");
const Alert_1 = require("../models/Alert");
const DeviceToken_1 = require("../models/DeviceToken");
const Job_1 = require("../models/Job");
const User_1 = require("../models/User");
const fcm_service_1 = require("../services/notification/fcm.service");
const email_service_1 = require("../services/notification/email.service");
const cronTracker_1 = require("../utils/cronTracker");
let alertTask = null;
let isRunning = false;
const buildJobFilter = (alert, since) => {
    const filter = {
        isNative: true,
        isActive: true,
        postedAt: { $gt: since },
    };
    if (alert.query && alert.query.trim().length > 0) {
        filter.$text = { $search: alert.query };
    }
    if (alert.location && alert.location.trim().length > 0) {
        filter.location = { $regex: alert.location, $options: 'i' };
    }
    const jobTypes = new Set(['full-time', 'part-time', 'contract', 'internship']);
    const remoteTypes = new Set(['remote', 'hybrid', 'onsite', 'on-site']);
    const skills = [];
    let jobType;
    let remoteType;
    for (const f of alert.filters) {
        const lc = f.toLowerCase();
        if (jobTypes.has(lc))
            jobType = lc;
        else if (remoteTypes.has(lc))
            remoteType = lc.replace('on-site', 'onsite');
        else
            skills.push(lc);
    }
    if (jobType)
        filter.jobType = jobType;
    if (remoteType)
        filter.remoteType = remoteType;
    if (skills.length > 0)
        filter.skills = { $in: skills };
    return filter;
};
const checkAlertsNow = async () => {
    const alerts = await Alert_1.Alert.find({ active: true });
    for (const alert of alerts) {
        try {
            const since = alert.lastNotifiedAt ?? alert.createdAt;
            const filter = buildJobFilter(alert, since);
            const jobs = await Job_1.Job.find(filter)
                .sort({ postedAt: -1 })
                .limit(constants_1.ALERT_PUSH_MAX_PER_RUN)
                .select('_id title company location url postedAt')
                .lean();
            if (jobs.length === 0)
                continue;
            const user = await User_1.User.findById(alert.user)
                .select('email profile.fullName profile.phone notificationPreferences')
                .lean();
            if (!user)
                continue;
            const prefs = user.notificationPreferences ?? {
                push: true,
                email: true,
                whatsapp: false,
                jobAlerts: true,
            };
            if (prefs.jobAlerts === false)
                continue;
            const newest = jobs[0];
            const headline = jobs.length === 1
                ? `${newest.title} at ${newest.company}`
                : `${newest.title} +${jobs.length - 1} more`;
            let result = {};
            if (prefs.push !== false) {
                const tokens = await DeviceToken_1.DeviceToken.find({ user: alert.user }).select('token');
                const tokenStrs = tokens.map((t) => t.token);
                result = await (0, fcm_service_1.sendToTokens)(tokenStrs, {
                    title: alert.label && alert.label.length > 0
                        ? `New for "${alert.label}"`
                        : 'New job match',
                    body: headline,
                    data: {
                        alertId: alert._id.toString(),
                        jobId: newest._id.toString(),
                    },
                });
            }
            if (prefs.email !== false && user.email) {
                try {
                    await (0, email_service_1.sendJobAlertEmail)({
                        toEmail: user.email,
                        fullName: user.profile?.fullName ?? 'there',
                        alertName: alert.label,
                        jobs: jobs,
                    });
                }
                catch (e) {
                    logger_1.logger.warn(`alert email send failed: ${e.message}`);
                }
            }
            alert.lastNotifiedAt = newest.postedAt ?? new Date();
            alert.notificationCount += jobs.length;
            await alert.save();
            if (result.invalidTokens && result.invalidTokens.length > 0) {
                await DeviceToken_1.DeviceToken.deleteMany({ token: { $in: result.invalidTokens } });
                logger_1.logger.info(`Alerts: pruned ${result.invalidTokens.length} dead tokens`);
            }
        }
        catch (err) {
            logger_1.logger.error(`Alerts: check failed for alert ${alert._id}`, err);
        }
    }
};
exports.checkAlertsNow = checkAlertsNow;
const startAlertCheckerCron = () => {
    if (!cronsEnabled())
        return;
    const schedule = (0, cronTracker_1.getCronSchedule)('alertChecker');
    if (!node_cron_1.default.validate(schedule)) {
        logger_1.logger.error(`Invalid alert cron expression: ${schedule}`);
        return;
    }
    alertTask = node_cron_1.default.schedule(schedule, (0, cronTracker_1.trackedCron)('alertChecker', async () => {
        if (isRunning) {
            logger_1.logger.warn('Alerts: previous tick still running — skipping');
            return;
        }
        isRunning = true;
        const start = Date.now();
        try {
            await (0, exports.checkAlertsNow)();
            logger_1.logger.info(`Alerts: tick complete in ${Date.now() - start}ms`);
        }
        finally {
            isRunning = false;
        }
    }), { timezone: 'Asia/Kolkata' });
    logger_1.logger.info(`Alerts cron scheduled: "${schedule}"`);
};
exports.startAlertCheckerCron = startAlertCheckerCron;
const stopAlertCheckerCron = () => {
    if (alertTask) {
        alertTask.stop();
        alertTask = null;
    }
};
exports.stopAlertCheckerCron = stopAlertCheckerCron;
