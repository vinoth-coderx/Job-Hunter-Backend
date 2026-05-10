/**
 * App-wide constants. Anything that is NOT a secret and NOT
 * environment-specific lives here — schedules, freshness windows,
 * default thresholds, third-party host names. Keeps `.env` reserved
 * for credentials and per-deployment overrides.
 *
 * Rule of thumb:
 *   - Different value per env (dev/staging/prod) → .env
 *   - Sensitive (key, secret, URI with creds)   → .env
 *   - Same on every deploy, project-wide config → here
 */

// ─── HTTP / API ──────────────────────────────────────────────────────
export const API_VERSION = 'v1';

// ─── JWT lifetimes ───────────────────────────────────────────────────
// Access tokens are short-lived; refresh tokens last a month so the
// app doesn't force a fresh login every week. The secrets themselves
// live in env (JWT_SECRET / JWT_REFRESH_SECRET).
export const JWT_EXPIRES_IN = '7d';
export const JWT_REFRESH_EXPIRES_IN = '30d';

// ─── Redis ───────────────────────────────────────────────────────────
export const REDIS_DB = 0;
export const REDIS_JOB_CACHE_TTL_SEC = 3600;

// ─── Job pipeline ────────────────────────────────────────────────────
// How recent a listing must be (in days) to count as "fresh" for the
// home feed and for the AI search's primary scope. Fresh listings are
// preferred; the search service additionally cascades to wider scopes
// when the primary set is empty.
export const JOB_FRESHNESS_DAYS = 10;

// AI matcher threshold (0–100) below which a job is filtered out from
// matched feed. Set conservatively so weakly-overlapping profiles still
// see something instead of an empty list.
export const AI_MATCH_THRESHOLD = 50;

// ─── Cron schedules ──────────────────────────────────────────────────
// Hourly job fetch from external APIs.
export const CRON_JOB_FETCH_SCHEDULE = '0 * * * *';
// Cache warmer every 6 hours.
export const CRON_CACHE_WARM_SCHEDULE = '0 */6 * * *';
// Alert checker every 15 minutes.
export const CRON_ALERT_SCHEDULE = '*/15 * * * *';
// Cap on push notifications per alert-cron run, to avoid overwhelming
// devices when a large batch of fresh jobs lands at once.
export const ALERT_PUSH_MAX_PER_RUN = 5;

// ─── Email (SMTP) ────────────────────────────────────────────────────
// Gmail relay defaults — only the credentials (SMTP_USER / SMTP_PASS)
// stay in env. Override the host/port here if you switch providers.
export const SMTP_HOST = 'smtp.gmail.com';
export const SMTP_PORT = 587;
export const EMAIL_FROM = 'Job Hunter <noreply@jobhunter.com>';

// ─── Third-party API hosts ──────────────────────────────────────────
// The keys themselves are in env; these are just well-known endpoints.
export const RAPIDAPI_JSEARCH_HOST = 'jsearch.p.rapidapi.com';
export const RAPIDAPI_LINKEDIN_HOST = 'linkedin-data-api.p.rapidapi.com';
export const ARBEITNOW_API_URL = 'https://www.arbeitnow.com/api/job-board-api';
export const THEIRSTACK_API_URL = 'https://api.theirstack.com/v1/jobs/search';

// Adzuna country code (used both in URL path and currency selection).
export const ADZUNA_COUNTRY = 'in';

// ─── Puppeteer / scrapers ───────────────────────────────────────────
export const PUPPETEER_HEADLESS = true;
export const SCRAPER_TIMEOUT_MS = 30_000;

// ─── Rate limiting ──────────────────────────────────────────────────
// Generous default for a multi-screen app: a fresh launch easily fires
// 20-30 requests (feed, applied, saved, notifications, profile, alerts)
// and the user comfortably racks up another 50+ in a few minutes of
// browsing. 600/15min ~= 40/min steady state — still tight enough to
// block scraping but doesn't surface "Too many requests" mid-session.
// Override at runtime via RATE_LIMIT_MAX_REQUESTS / RATE_LIMIT_WINDOW_MS.
export const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) > 0
  ? Number(process.env.RATE_LIMIT_WINDOW_MS)
  : 15 * 60 * 1000;
export const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) > 0
  ? Number(process.env.RATE_LIMIT_MAX_REQUESTS)
  : 600;
