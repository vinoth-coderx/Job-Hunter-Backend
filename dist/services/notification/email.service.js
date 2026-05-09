"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTeamInviteEmail = exports.sendJobAlertEmail = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const env_1 = require("../../config/env");
const logger_1 = require("../../utils/logger");
let transporter = null;
const getTransporter = () => {
    if (transporter)
        return transporter;
    if (!env_1.env.SMTP_HOST || !env_1.env.SMTP_USER || !env_1.env.SMTP_PASS)
        return null;
    transporter = nodemailer_1.default.createTransport({
        host: env_1.env.SMTP_HOST,
        port: env_1.env.SMTP_PORT,
        secure: env_1.env.SMTP_PORT === 465,
        auth: { user: env_1.env.SMTP_USER, pass: env_1.env.SMTP_PASS },
    });
    return transporter;
};
const escapeHtml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    const subject = params.jobs.length === 1
        ? `New job: ${params.jobs[0].title} at ${params.jobs[0].company}`
        : `${params.jobs.length} new jobs match your alert${params.alertName ? ` "${params.alertName}"` : ''}`;
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
            from: env_1.env.EMAIL_FROM,
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
    const subject = `You're invited to join ${params.companyName} on Job Hunter`;
    const html = renderTeamInviteHtml(params);
    try {
        await t.sendMail({
            from: env_1.env.EMAIL_FROM,
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
