"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopAiCostAlertCron = exports.startAiCostAlertCron = exports.runAiCostAlertNow = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const logger_1 = require("../utils/logger");
const cronTracker_1 = require("../utils/cronTracker");
const config_service_1 = require("../services/config/config.service");
const redis_1 = require("../config/redis");
const email_service_1 = require("../services/notification/email.service");
const costForecast_service_1 = require("../services/ai/costForecast.service");
const cronsEnabled = () => (0, config_service_1.getAppConfig)('CRON_ENABLED') !== 'false';
let task = null;
let isRunning = false;
const DEFAULT_THRESHOLD = 25;
const todayKey = () => {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
const buildHtml = (forecast, threshold) => {
    const rows = forecast.recent
        .slice(-7)
        .map((r) => `
        <tr>
          <td style="padding:6px 12px;font-family:monospace;color:#0a0a0a;">${r.date}</td>
          <td style="padding:6px 12px;text-align:right;font-family:monospace;color:#0a0a0a;">$${r.costUsd.toFixed(4)}</td>
          <td style="padding:6px 12px;text-align:right;font-family:monospace;color:#6b7280;">${r.calls}</td>
        </tr>`)
        .join('');
    return `
    <!DOCTYPE html>
    <html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;background:#f7f9fc;padding:24px 0;">
      <table style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;">
        <tr><td>
          <h1 style="font-size:18px;color:#b91c1c;margin:0 0 4px 0;">AI cost projection over threshold</h1>
          <p style="font-size:13px;color:#374151;margin:0 0 16px 0;">
            Projected 30-day spend is <b>$${forecast.projection30dUsd.toFixed(2)}</b>, threshold is <b>$${threshold.toFixed(2)}</b>.
          </p>
          <table style="width:100%;border-collapse:collapse;background:#f3f4f6;border-radius:8px;">
            <tr style="background:#1f2937;color:#fff;">
              <th style="padding:8px 12px;text-align:left;font-size:12px;">Date</th>
              <th style="padding:8px 12px;text-align:right;font-size:12px;">Cost (USD)</th>
              <th style="padding:8px 12px;text-align:right;font-size:12px;">Calls</th>
            </tr>
            ${rows}
          </table>
          <p style="font-size:12px;color:#6b7280;margin-top:16px;">
            Trailing daily avg: $${forecast.trailingDailyAvgUsd.toFixed(4)} ·
            7-day projection: $${forecast.projection7dUsd.toFixed(2)} ·
            Today so far: $${forecast.todayUsd.toFixed(4)}
          </p>
          <p style="font-size:11px;color:#9ca3af;margin-top:12px;">
            Tune via admin → AppConfig → AI_COST_ALERT_USD_30D / AI_COST_ALERT_RECIPIENTS.
          </p>
        </td></tr>
      </table>
    </body></html>`;
};
const runAiCostAlertNow = async () => {
    if ((0, config_service_1.getAppConfig)('AI_COST_ALERT_ENABLED') !== '1') {
        logger_1.logger.debug('aiCostAlert: AI_COST_ALERT_ENABLED != 1 — skipping');
        return;
    }
    const recipientsRaw = ((0, config_service_1.getAppConfig)('AI_COST_ALERT_RECIPIENTS') || '').trim();
    if (!recipientsRaw) {
        logger_1.logger.debug('aiCostAlert: no recipients configured — skipping');
        return;
    }
    const recipients = recipientsRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    if (recipients.length === 0)
        return;
    const thresholdRaw = ((0, config_service_1.getAppConfig)('AI_COST_ALERT_USD_30D') || '').trim();
    const threshold = thresholdRaw ? Number(thresholdRaw) : DEFAULT_THRESHOLD;
    if (!Number.isFinite(threshold) || threshold <= 0) {
        logger_1.logger.warn(`aiCostAlert: invalid threshold "${thresholdRaw}" — using default ${DEFAULT_THRESHOLD}`);
    }
    const effectiveThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD;
    const forecast = await (0, costForecast_service_1.getCostForecast)(30);
    if (forecast.projection30dUsd < effectiveThreshold) {
        logger_1.logger.info(`aiCostAlert: projection $${forecast.projection30dUsd} below threshold $${effectiveThreshold}`);
        return;
    }
    const day = todayKey();
    const key = `ai:cost-alert:sent:${day}:${effectiveThreshold}`;
    const set = await redis_1.redis.set(key, '1', 'EX', 60 * 60 * 26, 'NX');
    if (set !== 'OK') {
        logger_1.logger.info('aiCostAlert: already sent for today — skipping');
        return;
    }
    const subject = `AI spend forecast over $${effectiveThreshold.toFixed(0)} — Job Hunter`;
    const html = buildHtml(forecast, effectiveThreshold);
    for (const to of recipients) {
        try {
            await (0, email_service_1.sendEmail)({
                to,
                subject,
                html,
                rewriteType: 'admin_alert',
            });
        }
        catch (err) {
            logger_1.logger.warn(`aiCostAlert: send to ${to} failed: ${err.message}`);
        }
    }
    logger_1.logger.info(`aiCostAlert: sent to ${recipients.length} recipient(s) — projection $${forecast.projection30dUsd}`);
};
exports.runAiCostAlertNow = runAiCostAlertNow;
const startAiCostAlertCron = () => {
    if (!cronsEnabled())
        return;
    const schedule = (0, cronTracker_1.getCronSchedule)('aiCostAlert');
    if (!node_cron_1.default.validate(schedule)) {
        logger_1.logger.error(`Invalid aiCostAlert cron expression: ${schedule}`);
        return;
    }
    task = node_cron_1.default.schedule(schedule, (0, cronTracker_1.trackedCron)('aiCostAlert', async () => {
        if (isRunning) {
            logger_1.logger.warn('aiCostAlert: previous tick still running — skipping');
            return;
        }
        isRunning = true;
        const start = Date.now();
        try {
            await (0, exports.runAiCostAlertNow)();
            logger_1.logger.info(`aiCostAlert: tick complete in ${Date.now() - start}ms`);
        }
        catch (err) {
            logger_1.logger.warn(`aiCostAlert tick failed: ${err.message}`);
        }
        finally {
            isRunning = false;
        }
    }), { timezone: 'Asia/Kolkata' });
    logger_1.logger.info(`aiCostAlert cron scheduled: "${schedule}"`);
};
exports.startAiCostAlertCron = startAiCostAlertCron;
const stopAiCostAlertCron = () => {
    if (task) {
        task.stop();
        task = null;
    }
};
exports.stopAiCostAlertCron = stopAiCostAlertCron;
