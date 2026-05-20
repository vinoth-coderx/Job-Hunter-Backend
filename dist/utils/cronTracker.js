"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCronSchedule = exports.KNOWN_CRONS = exports.readCronStatus = exports.trackedCron = void 0;
const redis_1 = require("../config/redis");
const logger_1 = require("./logger");
const key = (name) => `cron:${name}`;
const recordCronRun = async (name, status, meta) => {
    const payload = {
        lastStatus: status,
        lastRunAt: new Date().toISOString(),
    };
    if (meta?.durationMs !== undefined) {
        payload.lastDurationMs = meta.durationMs.toString();
    }
    if (meta?.error) {
        payload.lastError = meta.error.slice(0, 500);
    }
    try {
        await redis_1.redis.hset(key(name), payload);
        if (status === 'success') {
            await redis_1.redis.hincrby(key(name), 'runCount', 1);
        }
        else if (status === 'failed') {
            await redis_1.redis.hincrby(key(name), 'failureCount', 1);
        }
    }
    catch (err) {
        logger_1.logger.warn(`cronTracker write failed for ${name}: ${err}`);
    }
};
const trackedCron = (name, fn) => {
    return async () => {
        const started = Date.now();
        await recordCronRun(name, 'running');
        try {
            await fn();
            await recordCronRun(name, 'success', {
                durationMs: Date.now() - started,
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            logger_1.logger.error(`Cron "${name}" failed: ${message}`, err);
            await recordCronRun(name, 'failed', {
                durationMs: Date.now() - started,
                error: message,
            });
        }
    };
};
exports.trackedCron = trackedCron;
const readCronStatus = async (name, schedule) => {
    try {
        const raw = await redis_1.redis.hgetall(key(name));
        return {
            name,
            schedule,
            lastStatus: raw.lastStatus || undefined,
            lastRunAt: raw.lastRunAt || undefined,
            lastDurationMs: raw.lastDurationMs
                ? parseInt(raw.lastDurationMs, 10)
                : undefined,
            lastError: raw.lastError || undefined,
            runCount: raw.runCount ? parseInt(raw.runCount, 10) : 0,
            failureCount: raw.failureCount ? parseInt(raw.failureCount, 10) : 0,
        };
    }
    catch (err) {
        logger_1.logger.warn(`cronTracker read failed for ${name}: ${err}`);
        return { name, schedule, runCount: 0, failureCount: 0 };
    }
};
exports.readCronStatus = readCronStatus;
exports.KNOWN_CRONS = [
    {
        name: 'subscriptionChecker',
        schedule: '0 0 * * *',
        description: 'Daily — expire stale subscriptions',
    },
    {
        name: 'appliedJobsCleanup',
        schedule: '0 2 * * *',
        description: 'Daily 02:00 IST — purge applied-job records older than 90 days',
    },
    {
        name: 'alertChecker',
        schedule: '*/15 * * * *',
        description: 'Every 15 min — match new jobs against user alerts',
    },
    {
        name: 'recommendedJobs',
        schedule: '*/30 * * * *',
        description: 'Every 30 min — system-generated push for high-match (>=70%) new jobs to every active seeker, independent of saved alerts',
    },
    {
        name: 'autoApply',
        schedule: '*/15 * * * *',
        description: 'Every 15 min — sweep users due for auto-apply (Asia/Kolkata)',
    },
    {
        name: 'trustMaintenance',
        schedule: '15 3 * * *',
        description: 'Daily 03:15 IST — recompute hirer trust scores + sweep inactive sessions',
    },
    {
        name: 'candidateSuggestionsWarmup',
        schedule: '30 4 * * *',
        description: 'Daily 04:30 IST — pre-warm AI candidate suggestions for active hirer jobs so the morning open is fast and free of fresh quota',
    },
    {
        name: 'aiCostAlert',
        schedule: '0 9 * * *',
        description: 'Daily 09:00 IST — email admins when 30-day AI spend projection crosses AI_COST_ALERT_USD_30D',
    },
];
const DEFAULT_SCHEDULES = exports.KNOWN_CRONS.reduce((acc, c) => {
    acc[c.name] = c.schedule;
    return acc;
}, {});
const getCronSchedule = (name) => {
    const { getAppConfig } = require('../services/config/config.service');
    const override = getAppConfig(`CRON_SCHEDULE_${name}`);
    return override && override.trim().length > 0
        ? override.trim()
        : DEFAULT_SCHEDULES[name] ?? '';
};
exports.getCronSchedule = getCronSchedule;
