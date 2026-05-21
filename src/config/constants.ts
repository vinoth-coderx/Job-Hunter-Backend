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
export const JOB_FRESHNESS_DAYS = 20;

// AI matcher threshold (0–100) below which a job is filtered out from
// matched feed. Set conservatively so weakly-overlapping profiles still
// see something instead of an empty list.
export const AI_MATCH_THRESHOLD = 50;

// ─── AI providers / models ───────────────────────────────────────────
// Gemini (free tier) is primary. Two models:
//   - "smart"   → 2.5 Flash, used for reasoning-heavy ops (matching, chat,
//                 JD generation, anticipatory recommendations).
//   - "lite"    → 2.5 Flash-Lite, used for fast structured extraction
//                 (resume parsing, suggestion lists) — costs less quota.
// Groq runs the fast lane (moderation triage, resume rewrite) via its own
// model identifiers in services/ai/providers/groq.provider.ts.
export const GEMINI_MODEL_SMART = 'gemini-2.5-flash';
export const GEMINI_MODEL_LITE = 'gemini-2.5-flash-lite';

// ─── AI quota (free tier protection) ─────────────────────────────────
// Per-user daily cap → soft limit, blocks just that user when hit.
// Global daily cap → hard limit on total project requests, must stay
// safely below Gemini free-tier RPD (~500) so we never get throttled
// at the SDK layer. Both reset at IST midnight (Asia/Kolkata).
export const AI_QUOTA_PER_USER_PER_DAY = 30;
export const AI_QUOTA_GLOBAL_PER_DAY = 400;
export const AI_QUOTA_TIMEZONE = 'Asia/Kolkata';

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
// OpenWebNinja hosts both JSearch (v2) and Real-Time Web Search under a
// single account + API key (X-API-Key header). Migrated off the RapidAPI
// marketplace because the v2 endpoint there was inconsistent and the
// X-RapidAPI-Key plan we had got rate-limited harder.
export const OPENWEBNINJA_BASE_URL = 'https://api.openwebninja.com';
// JSearch: `/search` is on all plans; `/search-v2` is a higher tier and
// returns 404 if your account doesn't subscribe to it. Defaulting to the
// universally-available `/search` — both endpoints return the same
// response shape (incl. `apply_options[]`) so the scraper code doesn't
// have to branch. Admin can override via OPENWEBNINJA_JSEARCH_PATH.
export const OPENWEBNINJA_JSEARCH_URL = `${OPENWEBNINJA_BASE_URL}/jsearch/search`;
// Real-Time Web Search slug observed on OpenWebNinja: `realtime-web-search`
// (no hyphen between "real" and "time"). Was previously
// `real-time-web-search`, which 403'd because that path doesn't exist on
// the gateway and the WAF treats unknown product paths as forbidden.
export const OPENWEBNINJA_WEBSEARCH_URL = `${OPENWEBNINJA_BASE_URL}/realtime-web-search/search`;
// Legacy — kept for the LinkedIn-Data scraper if/when it gets revived.
export const RAPIDAPI_LINKEDIN_HOST = 'linkedin-data-api.p.rapidapi.com';
export const ARBEITNOW_API_URL = 'https://www.arbeitnow.com/api/job-board-api';

// Adzuna country code (used both in URL path and currency selection).
export const ADZUNA_COUNTRY = 'in';

// ─── Puppeteer / scrapers ───────────────────────────────────────────
export const PUPPETEER_HEADLESS = true;
export const SCRAPER_TIMEOUT_MS = 30_000;

// Rate limiting moved to middleware/rateLimiter.ts — limits are now
// admin-managed via AppConfig (RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS)
// with the same defaults (15min / 600 req) used when no override is set.
