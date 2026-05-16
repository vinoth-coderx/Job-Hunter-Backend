import nodemailer, { Transporter } from 'nodemailer';
import { EMAIL_FROM, SMTP_HOST, SMTP_PORT } from '../../config/constants';
import { getAppConfig } from '../config/config.service';
import { logger } from '../../utils/logger';
import { IJob } from '../../models/Job';
import { polishEmailSubject } from '../ai/notificationCopy.service';

/**
 * Optionally polish an email subject via Groq when AppConfig flag
 * `EMAIL_AI_REWRITE` is '1'. Cached aggressively (30d) so recurring
 * subjects ("3 new jobs match your alert") only burn one rewrite per
 * exact-match line. Falls back silently to the original subject.
 */
const maybePolishSubject = async (
  subject: string,
  type: string,
  context?: Record<string, string | number>,
): Promise<string> => {
  if (getAppConfig('EMAIL_AI_REWRITE') !== '1') return subject;
  try {
    return await polishEmailSubject(subject, type, context);
  } catch (err) {
    logger.warn(`email subject polish skipped: ${(err as Error).message}`);
    return subject;
  }
};

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

// Generic email sender used by OTP / security flows that don't fit the
// templated alert paths above. Mirrors the same "no transporter →
// silently skip" semantics so unconfigured envs don't crash.
export const sendEmail = async (params: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  /** Optional AI-rewrite type tag — only used when EMAIL_AI_REWRITE='1'. */
  rewriteType?: string;
}): Promise<void> => {
  const t = getTransporter();
  if (!t) {
    logger.warn(`[email] transporter unavailable; skipping send to ${params.to}`);
    return;
  }
  const subject = await maybePolishSubject(
    params.subject,
    params.rewriteType ?? 'transactional',
  );
  await t.sendMail({
    from: EMAIL_FROM,
    to: params.to,
    subject,
    text: params.text,
    html: params.html,
  });
};

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

  const subject = await maybePolishSubject(
    params.jobs.length === 1
      ? `New job: ${params.jobs[0].title} at ${params.jobs[0].company}`
      : `${params.jobs.length} new jobs match your alert${params.alertName ? ` "${params.alertName}"` : ''}`,
    'job_alert',
    {
      count: params.jobs.length,
      ...(params.alertName ? { alert: params.alertName } : {}),
    },
  );

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

/**
 * Single-job recommendation email — sent by the `recommendedJobs` cron
 * whenever the system finds a >=70% match for the seeker. The CTA
 * routes through `https://jobhunter.app/job/<id>` so:
 *   - With the app installed → Android App Links / iOS Universal Links
 *     open the right screen directly.
 *   - Without the app → the marketing page at jobhunter.app/job/<id>
 *     surfaces Play Store + App Store install buttons (the same link
 *     opens the right screen once the user installs).
 *
 * The Play Store / App Store links are also rendered inline so the
 * recipient never has to hunt for them — they're the most common
 * "what is this?" follow-up question for a new install.
 */
const RECOMMENDED_JOB_APP_HOST = 'https://jobhunter.app';
// TODO(deploy): replace with the actual Play Store + App Store listings
// once the apps are published. Kept as placeholders so the templates
// render cleanly during development.
const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.example.job_hunter';
const APP_STORE_URL = 'https://apps.apple.com/app/job-hunter/id000000000';

const renderRecommendedJobHtml = (params: {
  fullName: string;
  job: {
    id: string;
    title: string;
    company: string;
    location: string;
    salaryText?: string;
    matchScore: number;
  };
}): string => {
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
          ${
            locationLine
              ? `<p style="font-size:13px;color:#6b7280;margin:0 0 18px 0;">
                   ${escapeHtml(locationLine)}
                 </p>`
              : ''
          }
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

export const sendRecommendedJobEmail = async (params: {
  toEmail: string;
  fullName: string;
  job: {
    id: string;
    title: string;
    company: string;
    location: string;
    salaryText?: string;
    matchScore: number;
  };
}): Promise<void> => {
  const t = getTransporter();
  if (!t) {
    logger.debug('SMTP not configured — skipping recommended job email');
    return;
  }
  const subject = await maybePolishSubject(
    `${params.job.matchScore}% match: ${params.job.title} at ${params.job.company}`,
    'recommended_job',
    {
      score: params.job.matchScore,
      company: params.job.company,
    },
  );
  const html = renderRecommendedJobHtml({
    fullName: params.fullName,
    job: params.job,
  });
  try {
    await t.sendMail({
      from: EMAIL_FROM,
      to: params.toEmail,
      subject,
      html,
    });
  } catch (err) {
    logger.warn(`recommended job email failed: ${(err as Error).message}`);
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
  const subject = await maybePolishSubject(
    `You're invited to join ${params.companyName} on Job Hunter`,
    'team_invite',
    { company: params.companyName, role: params.role },
  );
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
