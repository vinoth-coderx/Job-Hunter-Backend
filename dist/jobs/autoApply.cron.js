"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopAutoApplyCron = exports.startAutoApplyCron = exports.runAutoApplyTickNow = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const AutoApplySettings_1 = require("../models/AutoApplySettings");
const User_1 = require("../models/User");
const runner_1 = require("../services/autoApply/runner");
let task = null;
let isRunning = false;
const dayKeys = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
];
const istNow = () => {
    const ist = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
    const hh = String(ist.getUTCHours()).padStart(2, '0');
    const mm = String(ist.getUTCMinutes()).padStart(2, '0');
    return {
        day: dayKeys[ist.getUTCDay()],
        hh,
        mm,
    };
};
const isInRunWindow = (runTime, hh, mm) => {
    const [rh, rm] = runTime.split(':').map((s) => parseInt(s, 10));
    if (Number.isNaN(rh) || Number.isNaN(rm))
        return false;
    const nowMins = parseInt(hh, 10) * 60 + parseInt(mm, 10);
    const targetMins = rh * 60 + rm;
    let diff = nowMins - targetMins;
    if (diff > 12 * 60)
        diff -= 24 * 60;
    if (diff < -12 * 60)
        diff += 24 * 60;
    return Math.abs(diff) <= 7;
};
const runAutoApplyTickNow = async () => {
    const now = istNow();
    const candidates = await AutoApplySettings_1.AutoApplySettings.find({
        isEnabled: true,
        runDays: now.day,
    })
        .select('user runTime isPaused pauseUntil')
        .lean();
    const eligible = candidates.filter((c) => {
        if (!isInRunWindow(c.runTime, now.hh, now.mm))
            return false;
        if (c.isPaused) {
            if (!c.pauseUntil)
                return false;
            if (new Date(c.pauseUntil) > new Date())
                return false;
        }
        return true;
    });
    if (eligible.length === 0) {
        logger_1.logger.debug(`[autoApply] no eligible users at ${now.hh}:${now.mm} ${now.day}`);
        return;
    }
    logger_1.logger.info(`[autoApply] tick ${now.hh}:${now.mm} ${now.day} — ${eligible.length} users`);
    for (const c of eligible) {
        try {
            const user = await User_1.User.findById(c.user);
            if (!user)
                continue;
            const out = await (0, runner_1.runAutoApplyForUser)(user);
            if (out) {
                logger_1.logger.info(`[autoApply] ${user.email}: scanned=${out.jobsScanned} matched=${out.jobsMatched} applied=${out.jobsApplied} skipped=${out.jobsSkipped}`);
            }
        }
        catch (err) {
            logger_1.logger.error(`[autoApply] user ${c.user} failed: ${err.message}`);
        }
    }
};
exports.runAutoApplyTickNow = runAutoApplyTickNow;
const startAutoApplyCron = () => {
    if (!env_1.env.CRON_ENABLED)
        return;
    const expr = '*/15 * * * *';
    if (!node_cron_1.default.validate(expr)) {
        logger_1.logger.error(`Invalid auto-apply cron: ${expr}`);
        return;
    }
    task = node_cron_1.default.schedule(expr, async () => {
        if (isRunning) {
            logger_1.logger.warn('[autoApply] previous tick still running — skipping');
            return;
        }
        isRunning = true;
        const start = Date.now();
        try {
            await (0, exports.runAutoApplyTickNow)();
            logger_1.logger.info(`[autoApply] tick complete in ${Date.now() - start}ms`);
        }
        catch (err) {
            logger_1.logger.error('[autoApply] tick failed', err);
        }
        finally {
            isRunning = false;
        }
    }, { timezone: 'Asia/Kolkata' });
    logger_1.logger.info(`Auto-Apply cron scheduled: "${expr}" (Asia/Kolkata)`);
};
exports.startAutoApplyCron = startAutoApplyCron;
const stopAutoApplyCron = () => {
    if (task) {
        task.stop();
        task = null;
    }
};
exports.stopAutoApplyCron = stopAutoApplyCron;
