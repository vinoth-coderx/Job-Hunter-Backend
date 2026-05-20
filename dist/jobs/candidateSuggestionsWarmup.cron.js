"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopCandidateSuggestionsWarmupCron = exports.startCandidateSuggestionsWarmupCron = exports.runCandidateSuggestionsWarmupNow = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const logger_1 = require("../utils/logger");
const cronTracker_1 = require("../utils/cronTracker");
const config_service_1 = require("../services/config/config.service");
const Job_1 = require("../models/Job");
const AppliedJob_1 = require("../models/AppliedJob");
const User_1 = require("../models/User");
const HirerProfile_1 = require("../models/HirerProfile");
const candidateSuggester_service_1 = require("../services/ai/candidateSuggester.service");
const cronsEnabled = () => (0, config_service_1.getAppConfig)('CRON_ENABLED') !== 'false';
let task = null;
let isRunning = false;
const MAX_JOBS_PER_TICK = 50;
const POOL_SIZE = 50;
const SUGGEST_LIMIT = 10;
const runCandidateSuggestionsWarmupNow = async () => {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const jobs = await Job_1.Job.find({
        isNative: true,
        status: 'active',
        updatedAt: { $gte: since },
    })
        .sort({ updatedAt: -1 })
        .limit(MAX_JOBS_PER_TICK)
        .select('_id hirerProfile postedBy updatedAt')
        .lean();
    let warmed = 0;
    let skippedCached = 0;
    let skippedEmpty = 0;
    let failed = 0;
    for (const j of jobs) {
        try {
            const job = await Job_1.Job.findById(j._id);
            if (!job)
                continue;
            const existingApplicants = await AppliedJob_1.AppliedJob.distinct('user', {
                job: j._id,
            });
            const candidateRows = await AppliedJob_1.AppliedJob.aggregate([
                {
                    $match: {
                        hirerProfile: j.hirerProfile,
                        job: { $ne: j._id },
                        status: { $nin: ['rejected', 'withdrawn'] },
                        user: { $nin: existingApplicants },
                    },
                },
                { $group: { _id: '$user', lastSeenAt: { $max: '$appliedAt' } } },
                { $sort: { lastSeenAt: -1 } },
                { $limit: POOL_SIZE },
            ]);
            if (candidateRows.length === 0) {
                skippedEmpty += 1;
                continue;
            }
            const ids = candidateRows.map((c) => c._id.toString());
            const cached = await (0, candidateSuggester_service_1.peekCachedSuggestions)(j._id.toString(), job.updatedAt, ids);
            if (cached) {
                skippedCached += 1;
                continue;
            }
            const users = await User_1.User.find({
                _id: { $in: candidateRows.map((c) => c._id) },
            }).select('profile.fullName profile.headline profile.experienceYears profile.skills profile.resumeText profile.avatar');
            const lastSeenMap = new Map(candidateRows.map((c) => [c._id.toString(), c.lastSeenAt]));
            const pool = users.map((u) => ({
                userId: u._id.toString(),
                fullName: u.profile?.fullName ?? 'Candidate',
                headline: u.profile?.headline,
                experienceYears: u.profile?.experienceYears,
                skills: u.profile?.skills ?? [],
                resumeText: u.profile?.resumeText,
                lastSeenAt: lastSeenMap.get(u._id.toString())?.toISOString(),
            }));
            await (0, candidateSuggester_service_1.suggestCandidates)({
                job,
                pool,
                userId: j.postedBy.toString(),
                limit: SUGGEST_LIMIT,
            });
            warmed += 1;
        }
        catch (err) {
            failed += 1;
            logger_1.logger.warn(`[candidateWarmup] job=${j._id} failed: ${err.message}`);
        }
    }
    logger_1.logger.info(`[candidateWarmup] scanned=${jobs.length} warmed=${warmed} skippedCached=${skippedCached} skippedEmpty=${skippedEmpty} failed=${failed}`);
    const totalHirers = await HirerProfile_1.HirerProfile.countDocuments();
    logger_1.logger.info(`[candidateWarmup] totalHirers=${totalHirers}`);
};
exports.runCandidateSuggestionsWarmupNow = runCandidateSuggestionsWarmupNow;
const startCandidateSuggestionsWarmupCron = () => {
    if (!cronsEnabled())
        return;
    const schedule = (0, cronTracker_1.getCronSchedule)('candidateSuggestionsWarmup');
    if (!node_cron_1.default.validate(schedule)) {
        logger_1.logger.error(`Invalid candidateSuggestionsWarmup cron expression: ${schedule}`);
        return;
    }
    task = node_cron_1.default.schedule(schedule, (0, cronTracker_1.trackedCron)('candidateSuggestionsWarmup', async () => {
        if (isRunning) {
            logger_1.logger.warn('candidateSuggestionsWarmup: previous tick still running — skipping');
            return;
        }
        isRunning = true;
        const start = Date.now();
        try {
            await (0, exports.runCandidateSuggestionsWarmupNow)();
            logger_1.logger.info(`candidateSuggestionsWarmup: tick complete in ${Date.now() - start}ms`);
        }
        finally {
            isRunning = false;
        }
    }), { timezone: 'Asia/Kolkata' });
    logger_1.logger.info(`candidateSuggestionsWarmup cron scheduled: "${schedule}"`);
};
exports.startCandidateSuggestionsWarmupCron = startCandidateSuggestionsWarmupCron;
const stopCandidateSuggestionsWarmupCron = () => {
    if (task) {
        task.stop();
        task = null;
    }
};
exports.stopCandidateSuggestionsWarmupCron = stopCandidateSuggestionsWarmupCron;
