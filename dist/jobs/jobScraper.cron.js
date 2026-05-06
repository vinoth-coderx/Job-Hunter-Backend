"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runJobFetchNow = exports.stopJobScraperCron = exports.startJobScraperCron = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const scrapers_1 = require("../services/scrapers");
const jobCache_service_1 = require("../services/jobCache.service");
const Subscription_1 = require("../models/Subscription");
const User_1 = require("../models/User");
let jobScraperTask = null;
let subscriptionCheckerTask = null;
let cacheWarmTask = null;
let isRunning = false;
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
    if (node_cron_1.default.validate(env_1.env.CRON_CACHE_WARM_SCHEDULE)) {
        cacheWarmTask = node_cron_1.default.schedule(env_1.env.CRON_CACHE_WARM_SCHEDULE, async () => {
            try {
                const result = await (0, jobCache_service_1.warmJobsCache)();
                logger_1.logger.info('Cron: cache warmed', result);
            }
            catch (err) {
                logger_1.logger.error('Cron: cache warm failed', err);
            }
        }, { timezone: 'Asia/Kolkata' });
    }
    else {
        logger_1.logger.error(`Invalid cache warm cron: ${env_1.env.CRON_CACHE_WARM_SCHEDULE}`);
    }
    logger_1.logger.info(`Cron scheduled — job fetch: "${env_1.env.CRON_JOB_FETCH_SCHEDULE}", cache warm: "${env_1.env.CRON_CACHE_WARM_SCHEDULE}", sub check: daily 00:00`);
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
    if (cacheWarmTask) {
        cacheWarmTask.stop();
        cacheWarmTask = null;
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
