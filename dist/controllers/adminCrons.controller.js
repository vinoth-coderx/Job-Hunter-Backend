"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCronNow = exports.setCronSchedule = exports.setCronMaster = exports.getCronsOverview = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const cronTracker_1 = require("../utils/cronTracker");
const config_service_1 = require("../services/config/config.service");
const jobScraper_cron_1 = require("../jobs/jobScraper.cron");
const alertChecker_cron_1 = require("../jobs/alertChecker.cron");
const autoApply_cron_1 = require("../jobs/autoApply.cron");
const trustMaintenance_cron_1 = require("../jobs/trustMaintenance.cron");
const candidateSuggestionsWarmup_cron_1 = require("../jobs/candidateSuggestionsWarmup.cron");
const aiCostAlert_cron_1 = require("../jobs/aiCostAlert.cron");
const cronNextRun_1 = require("../utils/cronNextRun");
const RUNNERS = {
    subscriptionChecker: jobScraper_cron_1.runSubscriptionCheckNow,
    appliedJobsCleanup: jobScraper_cron_1.runAppliedJobsCleanupNow,
    alertChecker: alertChecker_cron_1.checkAlertsNow,
    autoApply: autoApply_cron_1.runAutoApplyTickNow,
    trustMaintenance: trustMaintenance_cron_1.runTrustMaintenanceNow,
    candidateSuggestionsWarmup: candidateSuggestionsWarmup_cron_1.runCandidateSuggestionsWarmupNow,
    aiCostAlert: aiCostAlert_cron_1.runAiCostAlertNow,
    jobScraper: async () => {
        await (0, jobScraper_cron_1.runJobFetchNow)();
    },
};
const cronsEnabled = () => (0, config_service_1.getAppConfig)('CRON_ENABLED') !== 'false';
const restartAllCrons = () => {
    (0, jobScraper_cron_1.stopJobScraperCron)();
    (0, alertChecker_cron_1.stopAlertCheckerCron)();
    (0, autoApply_cron_1.stopAutoApplyCron)();
    (0, trustMaintenance_cron_1.stopTrustMaintenanceCron)();
    (0, candidateSuggestionsWarmup_cron_1.stopCandidateSuggestionsWarmupCron)();
    (0, aiCostAlert_cron_1.stopAiCostAlertCron)();
    if (cronsEnabled()) {
        (0, jobScraper_cron_1.startJobScraperCron)();
        (0, alertChecker_cron_1.startAlertCheckerCron)();
        (0, autoApply_cron_1.startAutoApplyCron)();
        (0, trustMaintenance_cron_1.startTrustMaintenanceCron)();
        (0, candidateSuggestionsWarmup_cron_1.startCandidateSuggestionsWarmupCron)();
        (0, aiCostAlert_cron_1.startAiCostAlertCron)();
    }
};
exports.getCronsOverview = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const masterEnabled = cronsEnabled();
    const definitions = [
        ...cronTracker_1.KNOWN_CRONS.map((c) => ({
            name: c.name,
            schedule: (0, cronTracker_1.getCronSchedule)(c.name),
            defaultSchedule: c.schedule,
            description: c.description,
        })),
        {
            name: 'jobScraper',
            schedule: 'manual',
            defaultSchedule: 'manual',
            description: 'Manual — fetch jobs from every configured source',
        },
    ];
    const jobs = await Promise.all(definitions.map(async (d) => {
        const status = await (0, cronTracker_1.readCronStatus)(d.name, d.schedule);
        return {
            name: d.name,
            schedule: d.schedule,
            defaultSchedule: d.defaultSchedule,
            editable: d.schedule !== 'manual',
            enabled: masterEnabled,
            lastRunAt: status.lastRunAt,
            lastDurationMs: status.lastDurationMs,
            lastError: status.lastError,
            nextRunAt: d.schedule === 'manual' || !masterEnabled
                ? undefined
                : (0, cronNextRun_1.nextRunFromExpression)(d.schedule)?.toISOString(),
        };
    }));
    res.json({ masterEnabled, jobs });
});
exports.setCronMaster = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
        throw ApiError_1.ApiError.badRequest('enabled must be a boolean');
    }
    await (0, config_service_1.setAppConfig)({
        key: 'CRON_ENABLED',
        category: 'cron',
        isSecret: false,
        value: enabled ? 'true' : 'false',
        updatedBy: req.user?.id,
    });
    restartAllCrons();
    res.json({ enabled });
});
exports.setCronSchedule = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const name = req.params.name;
    if (typeof name !== 'string' || !name) {
        throw ApiError_1.ApiError.badRequest('Cron name required');
    }
    if (!cronTracker_1.KNOWN_CRONS.some((c) => c.name === name)) {
        throw ApiError_1.ApiError.notFound(`Unknown cron "${name}"`);
    }
    const schedule = typeof req.body?.schedule === 'string'
        ? req.body.schedule.trim()
        : '';
    if (!schedule) {
        throw ApiError_1.ApiError.badRequest('schedule (cron expression) is required');
    }
    if (!node_cron_1.default.validate(schedule)) {
        throw ApiError_1.ApiError.badRequest(`Invalid cron expression "${schedule}". Use the 5-field "min hr dom mon dow" syntax.`);
    }
    await (0, config_service_1.setAppConfig)({
        key: `CRON_SCHEDULE_${name}`,
        category: 'cron',
        isSecret: false,
        value: schedule,
        updatedBy: req.user?.id,
    });
    restartAllCrons();
    res.json({
        name,
        schedule,
        nextRunAt: (0, cronNextRun_1.nextRunFromExpression)(schedule)?.toISOString(),
    });
});
exports.runCronNow = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const name = req.params.name;
    if (typeof name !== 'string' || !name)
        throw ApiError_1.ApiError.badRequest('Cron name required');
    const runner = RUNNERS[name];
    if (!runner)
        throw ApiError_1.ApiError.notFound(`Unknown cron "${name}"`);
    const startedAt = new Date().toISOString();
    void runner().catch(() => {
    });
    res.json({ ok: true, startedAt });
});
