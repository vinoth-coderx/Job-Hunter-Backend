import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { redis } from '../../config/redis';
import { generate, isProviderEnabled } from './providers';
import type { NotificationType } from '../../types';

/**
 * AI rewriter for notification copy. Takes the system-default title/body
 * and returns a polished version that's tighter, more human, and
 * better-tuned for the platform (push vs email — but we currently only
 * use this for push since that's where character budget bites hardest).
 *
 * Goals per call:
 *   - Title: max ~50 chars, action-oriented, no emoji unless the input
 *     already had one.
 *   - Body: max ~120 chars (push-safe), 1-2 short sentences, friendly
 *     but not breezy. Keep concrete details (job title, company, score).
 *
 * Routed through Groq because notifications are high-volume and copy
 * rewriting is short. Cached aggressively (30d) by sha256(type + title +
 * body) — same recurring template (e.g. "5 new matches for Flutter
 * jobs") only burns one rewrite ever, then serves from cache.
 *
 * Failures return the original strings unchanged — notifications must
 * still go out even if the rewrite fails.
 */

export interface NotificationCopy {
  title: string;
  body: string;
}

export type RewriteKind = 'push' | 'email_subject';

export interface RewriteCopyArgs extends NotificationCopy {
  type: NotificationType | string;
  /** Optional context the model can use; e.g. company name, role, count. */
  context?: Record<string, string | number>;
  /**
   * Surface the copy is rewritten for. Push (default) caps at 50/120
   * chars; email_subject caps at 60 chars and ignores `body` entirely.
   */
  kind?: RewriteKind;
}

const cacheKey = (args: RewriteCopyArgs): string => {
  const ctx = args.context
    ? Object.entries(args.context)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('|')
    : '';
  const hash = crypto
    .createHash('sha256')
    .update(
      `${args.kind ?? 'push'}||${args.type}||${args.title}||${args.body}||${ctx}`,
    )
    .digest('hex')
    .slice(0, 24);
  return `ai:notif:${hash}`;
};

const SYSTEM_PUSH = `You rewrite mobile push notifications so they read better. RULES:

- Output STRICT JSON: {"title": "...", "body": "..."}.
- Title: max 50 chars, action-led when natural, no trailing period.
- Body: max 120 chars, 1-2 short sentences, friendly + specific.
- Preserve EVERY concrete detail in the input (job title, company, score, count, currency). NEVER invent.
- Never add emoji unless the input already had one.
- Never use ALL CAPS, exclamation marks, or marketing fluff ("amazing!", "don't miss!").
- If the input is already great, return it unchanged.
- Output ONLY the JSON, no markdown fences, no prose.`;

const SYSTEM_EMAIL_SUBJECT = `You rewrite transactional email subject lines so they get opened. RULES:

- Output STRICT JSON: {"title": "...", "body": ""}.
- Title (subject line): max 60 chars, specific, no trailing period.
- Preserve EVERY concrete detail (job title, company, count). NEVER invent.
- Never add emoji unless the input already had one.
- Never use ALL CAPS, exclamation marks, or marketing fluff.
- "body" MUST be an empty string — we only rewrite the subject for emails.
- If the input is already great, return it unchanged.
- Output ONLY the JSON, no markdown fences, no prose.`;

const systemFor = (kind: RewriteKind): string =>
  kind === 'email_subject' ? SYSTEM_EMAIL_SUBJECT : SYSTEM_PUSH;

const sanitize = (
  raw: unknown,
  fallback: NotificationCopy,
  kind: RewriteKind,
): NotificationCopy => {
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as { title?: unknown; body?: unknown };
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const body = typeof obj.body === 'string' ? obj.body.trim() : '';
  if (!title) return fallback;
  // Hard caps so a misbehaving model can't push a 600-char title to FCM
  // or stuff a body into an email subject. Push needs both fields; email
  // intentionally drops body to '' since the model is told to omit it.
  if (kind === 'email_subject') {
    return { title: title.slice(0, 80), body: '' };
  }
  if (!body) return fallback;
  return { title: title.slice(0, 80), body: body.slice(0, 200) };
};

/**
 * Rewrite notification copy. Returns the original on any failure so the
 * caller can plug this into the hot path without try/catch.
 */
export const rewriteNotificationCopy = async (
  args: RewriteCopyArgs,
): Promise<NotificationCopy> => {
  const kind: RewriteKind = args.kind ?? 'push';
  const fallback: NotificationCopy = { title: args.title, body: args.body };
  // Email subject only needs a title; push needs both. Skip the call if
  // the input doesn't carry the minimum we need to rewrite.
  if (!args.title.trim()) return fallback;
  if (kind === 'push' && !args.body.trim()) return fallback;

  const ck = cacheKey(args);
  try {
    const cached = await redis.get(ck);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as NotificationCopy;
        // Push needs title+body; email_subject only requires title.
        if (
          parsed.title &&
          (kind === 'email_subject' || parsed.body)
        ) {
          return parsed;
        }
      } catch {
        // fall through and recompute
      }
    }
  } catch (err) {
    logger.warn(`notificationCopy cache read: ${(err as Error).message}`);
  }

  const preferred: 'groq' | undefined = isProviderEnabled('groq')
    ? 'groq'
    : undefined;
  // No AI configured at all → fast-path the original copy. We don't burn
  // a quota slot just to no-op.
  if (!preferred && !isProviderEnabled('gemini')) {
    return fallback;
  }

  const userPrompt = [
    `Type: ${args.type}`,
    kind === 'email_subject' ? `Subject: ${args.title}` : `Title: ${args.title}`,
    args.body.trim() ? `Body: ${args.body}` : null,
    args.context
      ? `Context: ${Object.entries(args.context)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`
      : null,
    'Return the JSON now.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await generate(
      {
        provider: preferred,
        tier: 'lite',
        system: systemFor(kind),
        user: userPrompt,
        json: true,
        maxTokens: 200,
        temperature: 0.45,
      },
      { feature: 'notification_copy' },
    );

    const cleaned = res.text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return fallback;
    }
    const out = sanitize(parsed, fallback, kind);

    try {
      await redis.setex(ck, 60 * 60 * 24 * 30, JSON.stringify(out));
    } catch (err) {
      logger.warn(`notificationCopy cache write: ${(err as Error).message}`);
    }
    return out;
  } catch (err) {
    logger.warn(`notificationCopy failed: ${(err as Error).message}`);
    return fallback;
  }
};

/**
 * Convenience: rewrite just an email subject line. Returns the original
 * on any failure so the caller can drop this into the hot path without
 * try/catch. Email body remains unchanged — this only polishes subjects.
 */
export const polishEmailSubject = async (
  subject: string,
  type: NotificationType | string,
  context?: Record<string, string | number>,
): Promise<string> => {
  const result = await rewriteNotificationCopy({
    title: subject,
    body: '',
    type,
    context,
    kind: 'email_subject',
  });
  return result.title || subject;
};
