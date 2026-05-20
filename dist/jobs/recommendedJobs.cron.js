"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopRecommendedJobsCron = exports.startRecommendedJobsCron = exports.checkRecommendedJobsNow = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const Job_1 = require("../models/Job");
const Notification_1 = require("../models/Notification");
const User_1 = require("../models/User");
const config_service_1 = require("../services/config/config.service");
const notify_service_1 = require("../services/notification/notify.service");
const email_service_1 = require("../services/notification/email.service");
const scorer_1 = require("../services/autoApply/scorer");
const cronTracker_1 = require("../utils/cronTracker");
const logger_1 = require("../utils/logger");
const cronsEnabled = () => (0, config_service_1.getAppConfig)('CRON_ENABLED') !== 'false';
const MATCH_THRESHOLD = 70;
const MAX_USERS_PER_RUN = 200;
const MAX_JOBS_PER_USER_SCAN = 60;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
let task = null;
let isRunning = false;
const formatSalary = (job) => {
    const min = job.salaryMin;
    const max = job.salaryMax;
    const fmt = (n) => n >= 100000 ? `${(n / 100000).toFixed(1).replace(/\.0$/, '')}L` : `${Math.round(n / 1000)}k`;
    if (min && max && min !== max)
        return `₹${fmt(min)}–${fmt(max)}`;
    if (max)
        return `₹${fmt(max)}`;
    if (min)
        return `₹${fmt(min)}+`;
    return undefined;
};
const checkRecommendedJobsNow = async () => {
    const seekers = await User_1.User.find({
        activeRole: 'seeker',
        isBanned: { $ne: true },
        'notificationPreferences.push': { $ne: false },
        'notificationPreferences.jobAlerts': { $ne: false },
    })
        .select('_id email profile notificationPreferences lastRecommendedPushAt')
        .limit(MAX_USERS_PER_RUN);
    for (const user of seekers) {
        try {
            const hasSignals = (user.profile?.skills?.length ?? 0) > 0 ||
                (user.profile?.preferredRoles?.length ?? 0) > 0 ||
                (user.profile?.preferredLocations?.length ?? 0) > 0;
            if (!hasSignals)
                continue;
            const sinceCutoff = user.lastRecommendedPushAt ??
                new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);
            const candidates = await Job_1.Job.find({
                isNative: true,
                isActive: true,
                postedAt: { $gt: sinceCutoff },
            })
                .sort({ postedAt: -1 })
                .limit(MAX_JOBS_PER_USER_SCAN);
            if (candidates.length === 0)
                continue;
            let topJob = null;
            let topScore = 0;
            for (const job of candidates) {
                const { total } = (0, scorer_1.scoreForAutoApply)(user, job);
                if (total >= MATCH_THRESHOLD && total > topScore) {
                    topScore = total;
                    topJob = job;
                }
            }
            const now = new Date();
            if (!topJob) {
                user.lastRecommendedPushAt = now;
                await user.save();
                continue;
            }
            const dupeWindow = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const alreadyPushed = await Notification_1.Notification.exists({
                user: user._id,
                type: 'new_job_match',
                'data.jobId': topJob._id.toString(),
                createdAt: { $gt: dupeWindow },
            });
            if (alreadyPushed) {
                user.lastRecommendedPushAt = now;
                await user.save();
                continue;
            }
            await (0, notify_service_1.notifyUser)({
                user: user._id,
                role: 'seeker',
                type: 'new_job_match',
                title: `${topScore}% match · ${topJob.title}`,
                body: `${topJob.company}${topJob.location ? ` · ${topJob.location}` : ''}`,
                data: {
                    jobId: topJob._id.toString(),
                    matchScore: topScore,
                    source: 'recommended',
                },
            });
            if (user.notificationPreferences?.email !== false && user.email) {
                const salaryText = formatSalary(topJob);
                void (0, email_service_1.sendRecommendedJobEmail)({
                    toEmail: user.email,
                    fullName: user.profile?.fullName ?? 'there',
                    job: {
                        id: topJob._id.toString(),
                        title: topJob.title,
                        company: topJob.company,
                        location: topJob.location,
                        salaryText,
                        matchScore: topScore,
                    },
                }).catch((err) => {
                    logger_1.logger.warn(`RecommendedJobs: email send failed for ${user._id}: ${err.message}`);
                });
            }
            user.lastRecommendedPushAt = now;
            await user.save();
        }
        catch (err) {
            logger_1.logger.error(`RecommendedJobs: failed for user ${user._id}: ${err.message}`);
        }
    }
};
exports.checkRecommendedJobsNow = checkRecommendedJobsNow;
const startRecommendedJobsCron = () => {
    if (!cronsEnabled())
        return;
    const schedule = (0, cronTracker_1.getCronSchedule)('recommendedJobs');
    if (!node_cron_1.default.validate(schedule)) {
        logger_1.logger.error(`Invalid recommendedJobs cron expression: ${schedule}`);
        return;
    }
    task = node_cron_1.default.schedule(schedule, (0, cronTracker_1.trackedCron)('recommendedJobs', async () => {
        if (isRunning) {
            logger_1.logger.warn('RecommendedJobs: previous tick still running — skipping');
            return;
        }
        isRunning = true;
        const start = Date.now();
        try {
            await (0, exports.checkRecommendedJobsNow)();
            logger_1.logger.info(`RecommendedJobs: tick complete in ${Date.now() - start}ms`);
        }
        finally {
            isRunning = false;
        }
    }), { timezone: 'Asia/Kolkata' });
    logger_1.logger.info(`RecommendedJobs cron scheduled: "${schedule}"`);
};
exports.startRecommendedJobsCron = startRecommendedJobsCron;
const stopRecommendedJobsCron = () => {
    if (task) {
        task.stop();
        task = null;
    }
};
exports.stopRecommendedJobsCron = stopRecommendedJobsCron;
