"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runJobFetchNow = exports.stopJobScraperCron = exports.startJobScraperCron = exports.APPLIED_JOB_RETENTION_DAYS = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const scrapers_1 = require("../services/scrapers");
const Subscription_1 = require("../models/Subscription");
const User_1 = require("../models/User");
const AppliedJob_1 = require("../models/AppliedJob");
let jobScraperTask = null;
let subscriptionCheckerTask = null;
let appliedJobsCleanupTask = null;
let isRunning = false;
exports.APPLIED_JOB_RETENTION_DAYS = 90;
const startJobScraperCron = () => {
    if (!env_1.env.CRON_ENABLED) {
        logger_1.logger.info('Cron disabled by config');
        return;
    }
    if (!node_cron_1.default.validate(env_1.env.CRON_JOB_FETCH_SCHEDULE)) {
        logger_1.logger.error(`Invalid cron expression: ${env_1.env.CRON_JOB_FETCH_SCHEDULE}`);
        return;
    }
    jobScraperTask = node_cron_1.default.schedule(env_1.env.CRON_JOB_FETCH_SCHEDULE, async () => {
        if (isRunning) {
            logger_1.logger.warn('Previous job fetch still running — skipping this tick');
            return;
        }
        isRunning = true;
        const start = Date.now();
        try {
            logger_1.logger.info('Cron: starting hourly job fetch');
            const result = await (0, scrapers_1.fetchAllJobs)();
            logger_1.logger.info(`Cron: job fetch complete in ${Date.now() - start}ms`, result);
        }
        catch (err) {
            logger_1.logger.error('Cron: job fetch failed', err);
        }
        finally {
            isRunning = false;
        }
    }, { timezone: 'Asia/Kolkata' });
    subscriptionCheckerTask = node_cron_1.default.schedule('0 0 * * *', async () => {
        try {
            logger_1.logger.info('Cron: expiring stale subscriptions');
            const expired = await Subscription_1.Subscription.updateMany({ status: 'active', endDate: { $lt: new Date() } }, { $set: { status: 'expired' } });
            if (expired.modifiedCount > 0) {
                const expiredSubs = await Subscription_1.Subscription.find({ status: 'expired' }).distinct('user');
                await User_1.User.updateMany({ _id: { $in: expiredSubs } }, { $set: { 'subscription.tier': 'free', 'subscription.status': 'expired' } });
                logger_1.logger.info(`Expired ${expired.modifiedCount} subscriptions`);
            }
        }
        catch (err) {
            logger_1.logger.error('Cron: subscription expiry check failed', err);
        }
    }, { timezone: 'Asia/Kolkata' });
    appliedJobsCleanupTask = node_cron_1.default.schedule('0 2 * * *', async () => {
        try {
            const cutoff = new Date(Date.now() - exports.APPLIED_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000);
            const result = await AppliedJob_1.AppliedJob.deleteMany({ appliedAt: { $lt: cutoff } });
            if (result.deletedCount > 0) {
                logger_1.logger.info(`Cron: purged ${result.deletedCount} applied-job records older than ${exports.APPLIED_JOB_RETENTION_DAYS} days`);
            }
        }
        catch (err) {
            logger_1.logger.error('Cron: applied-jobs cleanup failed', err);
        }
    }, { timezone: 'Asia/Kolkata' });
    logger_1.logger.info(`Cron scheduled — job fetch: "${env_1.env.CRON_JOB_FETCH_SCHEDULE}", sub check: daily 00:00, applied-jobs cleanup: daily 02:00 (>${exports.APPLIED_JOB_RETENTION_DAYS}d)`);
};
exports.startJobScraperCron = startJobScraperCron;
const stopJobScraperCron = () => {
    if (jobScraperTask) {
        jobScraperTask.stop();
        jobScraperTask = null;
    }
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
        return await (0, scrapers_1.fetchAllJobs)();
    }
    finally {
        isRunning = false;
    }
};
exports.runJobFetchNow = runJobFetchNow;
