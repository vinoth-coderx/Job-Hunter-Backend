"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTeamInviteEmail = exports.sendRecommendedJobEmail = exports.sendJobAlertEmail = exports.sendEmail = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const constants_1 = require("../../config/constants");
const config_service_1 = require("../config/config.service");
const logger_1 = require("../../utils/logger");
const notificationCopy_service_1 = require("../ai/notificationCopy.service");
const maybePolishSubject = async (subject, type, context) => {
    if ((0, config_service_1.getAppConfig)('EMAIL_AI_REWRITE') !== '1')
        return subject;
    try {
        return await (0, notificationCopy_service_1.polishEmailSubject)(subject, type, context);
    }
    catch (err) {
        logger_1.logger.warn(`email subject polish skipped: ${err.message}`);
        return subject;
    }
};
let transporter = null;
let configuredFor = null;
const getTransporter = () => {
    const user = (0, config_service_1.getAppConfig)('SMTP_USER');
    const pass = (0, config_service_1.getAppConfig)('SMTP_PASS');
    if (!user || !pass)
        return null;
    if (transporter && configuredFor === user)
        return transporter;
    transporter = nodemailer_1.default.createTransport({
        host: constants_1.SMTP_HOST,
        port: constants_1.SMTP_PORT,
        secure: constants_1.SMTP_PORT === 465,
        auth: { user, pass },
    });
    configuredFor = user;
    return transporter;
};
const escapeHtml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const sendEmail = async (params) => {
    const t = getTransporter();
    if (!t) {
        logger_1.logger.warn(`[email] transporter unavailable; skipping send to ${params.to}`);
        return;
    }
    const subject = await maybePolishSubject(params.subject, params.rewriteType ?? 'transactional');
    await t.sendMail({
        from: constants_1.EMAIL_FROM,
        to: params.to,
        subject,
        text: params.text,
        html: params.html,
    });
};
exports.sendEmail = sendEmail;
const renderJobAlertHtml = (params) => {
    const { fullName, jobs, alertName } = params;
    const heading = alertName
        ? `New jobs for "${escapeHtml(alertName)}"`
        : 'New jobs matched for you';
    const jobsHtml = jobs
        .map((j) => `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #eee;">
            <div style="font-weight:700;font-size:15px;color:#0a0a0a;">
              ${escapeHtml(j.title)}
            </div>
            <div style="font-size:13px;color:#6b7280;margin-top:2px;">
              ${escapeHtml(j.company)} · ${escapeHtml(j.location)}
            </div>
            <div style="margin-top:8px;">
              <a href="${escapeHtml(j.url)}"
                 style="background:#2D7BFF;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">
                View job
              </a>
            </div>
          </td>
        </tr>`)
        .join('');
    return `
    <!DOCTYPE html>
    <html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;background:#f7f9fc;padding:24px 0;">
      <table style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;">
        <tr><td>
          <h1 style="font-size:18px;color:#0a0a0a;margin:0 0 4px 0;">${escapeHtml(heading)}</h1>
          <p style="font-size:13px;color:#6b7280;margin:0 0 16px 0;">
            Hi ${escapeHtml(fullName)}, here's what we found.
          </p>
          <table style="width:100%;border-collapse:collapse;">
            ${jobsHtml}
          </table>
          <p style="font-size:11px;color:#9ca3af;margin-top:16px;">
            You're getting this email because you turned on email job alerts.
            Manage preferences in your Job Hunter app.
          </p>
        </td></tr>
      </table>
    </body></html>`;
};
const sendJobAlertEmail = async (params) => {
    const t = getTransporter();
    if (!t) {
        logger_1.logger.debug('SMTP not configured — skipping email job alert');
        return;
    }
    if (params.jobs.length === 0)
        return;
    const subject = await maybePolishSubject(params.jobs.length === 1
        ? `New job: ${params.jobs[0].title} at ${params.jobs[0].company}`
        : `${params.jobs.length} new jobs match your alert${params.alertName ? ` "${params.alertName}"` : ''}`, 'job_alert', {
        count: params.jobs.length,
        ...(params.alertName ? { alert: params.alertName } : {}),
    });
    const html = renderJobAlertHtml({
        fullName: params.fullName,
        alertName: params.alertName,
        jobs: params.jobs.map((j) => ({
            title: j.title,
            company: j.company,
            location: j.location,
            url: j.url,
        })),
    });
    try {
        await t.sendMail({
            from: constants_1.EMAIL_FROM,
            to: params.toEmail,
            subject,
            html,
        });
    }
    catch (err) {
        logger_1.logger.warn(`email job alert failed: ${err.message}`);
    }
};
exports.sendJobAlertEmail = sendJobAlertEmail;
const RECOMMENDED_JOB_APP_HOST = 'https://jobhunter.app';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.example.job_hunter';
const APP_STORE_URL = 'https://apps.apple.com/app/job-hunter/id000000000';
const renderRecommendedJobHtml = (params) => {
    const { fullName, job } = params;
    const openInAppUrl = `${RECOMMENDED_JOB_APP_HOST}/job/${encodeURIComponent(job.id)}`;
    const locationLine = [job.location, job.salaryText].filter(Boolean).join(' · ');
    return `
    <!DOCTYPE html>
    <html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;background:#f7f9fc;padding:24px 0;margin:0;">
      <table style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
        <tr><td>
          <div style="display:inline-block;background:#E6F0FF;color:#1857C2;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:0.2px;">
            ${job.matchScore}% match
          </div>
          <h1 style="font-size:20px;color:#0a0a0a;margin:14px 0 6px 0;line-height:1.3;">
            ${escapeHtml(job.title)}
          </h1>
          <p style="font-size:14px;color:#374151;margin:0 0 4px 0;font-weight:600;">
            ${escapeHtml(job.company)}
          </p>
          ${locationLine
        ? `<p style="font-size:13px;color:#6b7280;margin:0 0 18px 0;">
                   ${escapeHtml(locationLine)}
                 </p>`
        : ''}
          <p style="font-size:14px;color:#374151;margin:0 0 18px 0;line-height:1.5;">
            Hi ${escapeHtml(fullName)}, this just landed and looks like a
            strong fit for your profile.
          </p>
          <div style="margin:18px 0 8px 0;">
            <a href="${escapeHtml(openInAppUrl)}"
               style="background:#2D7BFF;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:700;display:inline-block;">
              Open in app
            </a>
          </div>
          <p style="font-size:12px;color:#6b7280;margin:14px 0 6px 0;">
            Don't have the app yet?
          </p>
          <table style="border-collapse:collapse;">
            <tr>
              <td style="padding-right:8px;">
                <a href="${escapeHtml(PLAY_STORE_URL)}"
                   style="display:inline-block;background:#0a0a0a;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-size:12px;font-weight:600;">
                  Get on Google Play
                </a>
              </td>
              <td>
                <a href="${escapeHtml(APP_STORE_URL)}"
                   style="display:inline-block;background:#0a0a0a;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-size:12px;font-weight:600;">
                  Download on App Store
                </a>
              </td>
            </tr>
          </table>
          <p style="font-size:11px;color:#9ca3af;margin-top:22px;">
            You're getting this email because email recommendations are
            on. Turn them off any time from
            <em>Profile → Notification preferences</em>.
          </p>
        </td></tr>
      </table>
    </body></html>`;
};
const sendRecommendedJobEmail = async (params) => {
    const t = getTransporter();
    if (!t) {
        logger_1.logger.debug('SMTP not configured — skipping recommended job email');
        return;
    }
    const subject = await maybePolishSubject(`${params.job.matchScore}% match: ${params.job.title} at ${params.job.company}`, 'recommended_job', {
        score: params.job.matchScore,
        company: params.job.company,
    });
    const html = renderRecommendedJobHtml({
        fullName: params.fullName,
        job: params.job,
    });
    try {
        await t.sendMail({
            from: constants_1.EMAIL_FROM,
            to: params.toEmail,
            subject,
            html,
        });
    }
    catch (err) {
        logger_1.logger.warn(`recommended job email failed: ${err.message}`);
    }
};
exports.sendRecommendedJobEmail = sendRecommendedJobEmail;
const renderTeamInviteHtml = (params) => {
    const { companyName, inviterName, role, token, expiresAt } = params;
    const expires = expiresAt.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
    const intro = inviterName
        ? `${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(companyName)}</strong>`
        : `You've been invited to join <strong>${escapeHtml(companyName)}</strong>`;
    return `
    <!DOCTYPE html>
    <html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;background:#f7f9fc;padding:24px 0;">
      <table style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
        <tr><td>
          <h1 style="font-size:20px;color:#0a0a0a;margin:0 0 8px 0;">You're invited to a hiring team</h1>
          <p style="font-size:14px;color:#374151;margin:0 0 16px 0;line-height:1.5;">
            ${intro} as a <strong>${escapeHtml(role)}</strong>.
          </p>
          <p style="font-size:13px;color:#6b7280;margin:0 0 8px 0;">
            Open the Job Hunter app, go to <strong>Team → Accept invite</strong>, and paste this token:
          </p>
          <div style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin:8px 0 16px 0;">
            <code style="font-family:'SFMono-Regular',Consolas,monospace;font-size:13px;color:#0a0a0a;word-break:break-all;">
              ${escapeHtml(token)}
            </code>
          </div>
          <p style="font-size:12px;color:#9ca3af;margin:0;">
            This invite expires on <strong>${escapeHtml(expires)}</strong>. If you weren't expecting this, you can safely ignore the email.
          </p>
        </td></tr>
      </table>
    </body></html>`;
};
const sendTeamInviteEmail = async (params) => {
    const t = getTransporter();
    if (!t) {
        logger_1.logger.debug('SMTP not configured — skipping team invite email');
        return;
    }
    const subject = await maybePolishSubject(`You're invited to join ${params.companyName} on Job Hunter`, 'team_invite', { company: params.companyName, role: params.role });
    const html = renderTeamInviteHtml(params);
    try {
        await t.sendMail({
            from: constants_1.EMAIL_FROM,
            to: params.toEmail,
            subject,
            html,
        });
    }
    catch (err) {
        logger_1.logger.warn(`team invite email failed: ${err.message}`);
    }
};
exports.sendTeamInviteEmail = sendTeamInviteEmail;
