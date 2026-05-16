import cron, { ScheduledTask } from 'node-cron';
import { logger } from '../utils/logger';
import { trackedCron, getCronSchedule } from '../utils/cronTracker';
import { getAppConfig } from '../services/config/config.service';
import { redis } from '../config/redis';
import { sendEmail } from '../services/notification/email.service';
import { getCostForecast, CostForecast } from '../services/ai/costForecast.service';

/**
 * Daily AI cost alert. Wakes up once a day, asks the forecast service
 * what the trailing 30-day projection looks like, and emails the
 * configured recipients when the projected spend crosses the
 * threshold. Idempotent per day — once an alert fires for a given
 * (YYYY-MM-DD + threshold) we don't re-send until the next day.
 *
 * Config keys (all in AppConfig):
 *   - AI_COST_ALERT_USD_30D       → threshold, default 25.00
 *   - AI_COST_ALERT_RECIPIENTS    → comma-separated emails
 *   - AI_COST_ALERT_ENABLED       → '1' to enable, default off
 */

const cronsEnabled = (): boolean => getAppConfig('CRON_ENABLED') !== 'false';

let task: ScheduledTask | null = null;
let isRunning = false;

const DEFAULT_THRESHOLD = 25;

const todayKey = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

const buildHtml = (
  forecast: CostForecast,
  threshold: number,
): string => {
  const rows = forecast.recent
    .slice(-7)
    .map(
      (r) => `
        <tr>
          <td style="padding:6px 12px;font-family:monospace;color:#0a0a0a;">${r.date}</td>
          <td style="padding:6px 12px;text-align:right;font-family:monospace;color:#0a0a0a;">$${r.costUsd.toFixed(4)}</td>
          <td style="padding:6px 12px;text-align:right;font-family:monospace;color:#6b7280;">${r.calls}</td>
        </tr>`,
    )
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

export const runAiCostAlertNow = async (): Promise<void> => {
  if (getAppConfig('AI_COST_ALERT_ENABLED') !== '1') {
    logger.debug('aiCostAlert: AI_COST_ALERT_ENABLED != 1 — skipping');
    return;
  }
  const recipientsRaw = (getAppConfig('AI_COST_ALERT_RECIPIENTS') || '').trim();
  if (!recipientsRaw) {
    logger.debug('aiCostAlert: no recipients configured — skipping');
    return;
  }
  const recipients = recipientsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (recipients.length === 0) return;

  const thresholdRaw = (getAppConfig('AI_COST_ALERT_USD_30D') || '').trim();
  const threshold = thresholdRaw ? Number(thresholdRaw) : DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    logger.warn(`aiCostAlert: invalid threshold "${thresholdRaw}" — using default ${DEFAULT_THRESHOLD}`);
  }
  const effectiveThreshold =
    Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD;

  const forecast = await getCostForecast(30);
  if (forecast.projection30dUsd < effectiveThreshold) {
    logger.info(
      `aiCostAlert: projection $${forecast.projection30dUsd} below threshold $${effectiveThreshold}`,
    );
    return;
  }

  // Idempotency — one email per day per threshold value. Threshold is
  // part of the key so an admin lowering the threshold immediately
  // re-arms the alert without waiting for tomorrow.
  const day = todayKey();
  const key = `ai:cost-alert:sent:${day}:${effectiveThreshold}`;
  const set = await redis.set(key, '1', 'EX', 60 * 60 * 26, 'NX');
  if (set !== 'OK') {
    logger.info('aiCostAlert: already sent for today — skipping');
    return;
  }

  const subject = `AI spend forecast over $${effectiveThreshold.toFixed(0)} — Job Hunter`;
  const html = buildHtml(forecast, effectiveThreshold);
  for (const to of recipients) {
    try {
      await sendEmail({
        to,
        subject,
        html,
        rewriteType: 'admin_alert',
      });
    } catch (err) {
      logger.warn(
        `aiCostAlert: send to ${to} failed: ${(err as Error).message}`,
      );
    }
  }
  logger.info(
    `aiCostAlert: sent to ${recipients.length} recipient(s) — projection $${forecast.projection30dUsd}`,
  );
};

export const startAiCostAlertCron = (): void => {
  if (!cronsEnabled()) return;
  const schedule = getCronSchedule('aiCostAlert');
  if (!cron.validate(schedule)) {
    logger.error(`Invalid aiCostAlert cron expression: ${schedule}`);
    return;
  }
  task = cron.schedule(
    schedule,
    trackedCron('aiCostAlert', async () => {
      if (isRunning) {
        logger.warn('aiCostAlert: previous tick still running — skipping');
        return;
      }
      isRunning = true;
      const start = Date.now();
      try {
        await runAiCostAlertNow();
        logger.info(
          `aiCostAlert: tick complete in ${Date.now() - start}ms`,
        );
      } catch (err) {
        logger.warn(`aiCostAlert tick failed: ${(err as Error).message}`);
      } finally {
        isRunning = false;
      }
    }),
    { timezone: 'Asia/Kolkata' },
  );
  logger.info(`aiCostAlert cron scheduled: "${schedule}"`);
};

export const stopAiCostAlertCron = (): void => {
  if (task) {
    task.stop();
    task = null;
  }
};
