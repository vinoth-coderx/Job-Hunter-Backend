"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runJobFetchNow = exports.stopJobScraperCron = exports.startJobScraperCron = exports.runAppliedJobsCleanupNow = exports.runSubscriptionCheckNow = exports.APPLIED_JOB_VIEW_DAYS = exports.APPLIED_JOB_RETENTION_DAYS = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const config_service_1 = require("../services/config/config.service");
const logger_1 = require("../utils/logger");
const cronsEnabled = () => (0, config_service_1.getAppConfig)('CRON_ENABLED') !== 'false';
const scrapers_1 = require("../services/scrapers");
const Subscription_1 = require("../models/Subscription");
const User_1 = require("../models/User");
const AppliedJob_1 = require("../models/AppliedJob");
const cronTracker_1 = require("../utils/cronTracker");
let subscriptionCheckerTask = null;
let appliedJobsCleanupTask = null;
let isRunning = false;
exports.APPLIED_JOB_RETENTION_DAYS = 90;
exports.APPLIED_JOB_VIEW_DAYS = 30;
const runSubscriptionCheckNow = async () => {
    logger_1.logger.info('Cron: expiring stale subscriptions');
    const expired = await Subscription_1.Subscription.updateMany({ status: 'active', endDate: { $lt: new Date() } }, { $set: { status: 'expired' } });
    if (expired.modifiedCount > 0) {
        const expiredSubs = await Subscription_1.Subscription.find({ status: 'expired' }).distinct('user');
        await User_1.User.updateMany({ _id: { $in: expiredSubs } }, { $set: { 'subscription.tier': 'free', 'subscription.status': 'expired' } });
        logger_1.logger.info(`Expired ${expired.modifiedCount} subscriptions`);
    }
};
exports.runSubscriptionCheckNow = runSubscriptionCheckNow;
const runAppliedJobsCleanupNow = async () => {
    const cutoff = new Date(Date.now() - exports.APPLIED_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await AppliedJob_1.AppliedJob.deleteMany({ appliedAt: { $lt: cutoff } });
    if (result.deletedCount > 0) {
        logger_1.logger.info(`Cron: purged ${result.deletedCount} applied-job records older than ${exports.APPLIED_JOB_RETENTION_DAYS} days`);
    }
};
exports.runAppliedJobsCleanupNow = runAppliedJobsCleanupNow;
const startJobScraperCron = () => {
    if (!cronsEnabled()) {
        logger_1.logger.info('Cron disabled by config');
        return;
    }
    const subSchedule = (0, cronTracker_1.getCronSchedule)('subscriptionChecker');
    const cleanupSchedule = (0, cronTracker_1.getCronSchedule)('appliedJobsCleanup');
    if (!node_cron_1.default.validate(subSchedule)) {
        logger_1.logger.error(`Invalid subscriptionChecker cron: ${subSchedule}`);
    }
    else {
        subscriptionCheckerTask = node_cron_1.default.schedule(subSchedule, (0, cronTracker_1.trackedCron)('subscriptionChecker', exports.runSubscriptionCheckNow), { timezone: 'Asia/Kolkata' });
    }
    if (!node_cron_1.default.validate(cleanupSchedule)) {
        logger_1.logger.error(`Invalid appliedJobsCleanup cron: ${cleanupSchedule}`);
    }
    else {
        appliedJobsCleanupTask = node_cron_1.default.schedule(cleanupSchedule, (0, cronTracker_1.trackedCron)('appliedJobsCleanup', exports.runAppliedJobsCleanupNow), { timezone: 'Asia/Kolkata' });
    }
    logger_1.logger.info(`Cron scheduled — sub check: "${subSchedule}", applied-jobs cleanup: "${cleanupSchedule}" (>${exports.APPLIED_JOB_RETENTION_DAYS}d)`);
};
exports.startJobScraperCron = startJobScraperCron;
const stopJobScraperCron = () => {
    if (subscriptionCheckerTask) {
        subscriptionCheckerTask.stop();
        subscriptionCheckerTask = null;
    }
    if (appliedJobsCleanupTask) {
        appliedJobsCleanupTask.stop();
        appliedJobsCleanupTask = null;
    }
    logger_1.logger.info('Cron stopped');
};
exports.stopJobScraperCron = stopJobScraperCron;
const runJobFetchNow = async () => {
    if (isRunning)
        throw new Error('A job fetch is already in progress');
    isRunning = true;
    try {
        return await (0, scrapers_1.fetchAllJobs)({ usePuppeteer: true });
    }
    finally {
        isRunning = false;
    }
};
exports.runJobFetchNow = runJobFetchNow;
