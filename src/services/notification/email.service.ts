import nodemailer, { Transporter } from 'nodemailer';
import { EMAIL_FROM, SMTP_HOST, SMTP_PORT } from '../../config/constants';
import { getAppConfig } from '../config/config.service';
import { logger } from '../../utils/logger';
import { IJob } from '../../models/Job';

let transporter: Transporter | null = null;
let configuredFor: string | null = null;

const getTransporter = (): Transporter | null => {
  const user = getAppConfig('SMTP_USER');
  const pass = getAppConfig('SMTP_PASS');
  if (!user || !pass) return null;
  // Rebuild the transporter if the admin rotated credentials at runtime.
  if (transporter && configuredFor === user) return transporter;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    // Implicit TLS only on port 465; STARTTLS for 587/25.
    secure: (SMTP_PORT as number) === 465,
    auth: { user, pass },
  });
  configuredFor = user;
  return transporter;
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderJobAlertHtml = (params: {
  fullName: string;
  jobs: { title: string; company: string; location: string; url: string }[];
  alertName?: string;
}): string => {
  const { fullName, jobs, alertName } = params;
  const heading = alertName
    ? `New jobs for "${escapeHtml(alertName)}"`
    : 'New jobs matched for you';

  const jobsHtml = jobs
    .map(
      (j) => `
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
        </tr>`,
    )
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

export const sendJobAlertEmail = async (params: {
  toEmail: string;
  fullName: string;
  alertName?: string;
  jobs: IJob[];
}): Promise<void> => {
  const t = getTransporter();
  if (!t) {
    logger.debug('SMTP not configured — skipping email job alert');
    return;
  }
  if (params.jobs.length === 0) return;

  const subject =
    params.jobs.length === 1
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
      from: EMAIL_FROM,
      to: params.toEmail,
      subject,
      html,
    });
  } catch (err) {
    logger.warn(`email job alert failed: ${(err as Error).message}`);
  }
};

const renderTeamInviteHtml = (params: {
  companyName: string;
  inviterName?: string;
  role: string;
  token: string;
  expiresAt: Date;
}): string => {
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

export const sendTeamInviteEmail = async (params: {
  toEmail: string;
  companyName: string;
  inviterName?: string;
  role: string;
  token: string;
  expiresAt: Date;
}): Promise<void> => {
  const t = getTransporter();
  if (!t) {
    logger.debug('SMTP not configured — skipping team invite email');
    return;
  }
  const subject = `You're invited to join ${params.companyName} on Job Hunter`;
  const html = renderTeamInviteHtml(params);
  try {
    await t.sendMail({
      from: EMAIL_FROM,
      to: params.toEmail,
      subject,
      html,
    });
  } catch (err) {
    logger.warn(`team invite email failed: ${(err as Error).message}`);
  }
};
