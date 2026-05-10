"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RATE_LIMIT_MAX_REQUESTS = exports.RATE_LIMIT_WINDOW_MS = exports.SCRAPER_TIMEOUT_MS = exports.PUPPETEER_HEADLESS = exports.ADZUNA_COUNTRY = exports.THEIRSTACK_API_URL = exports.ARBEITNOW_API_URL = exports.RAPIDAPI_LINKEDIN_HOST = exports.RAPIDAPI_JSEARCH_HOST = exports.EMAIL_FROM = exports.SMTP_PORT = exports.SMTP_HOST = exports.ALERT_PUSH_MAX_PER_RUN = exports.CRON_ALERT_SCHEDULE = exports.CRON_CACHE_WARM_SCHEDULE = exports.CRON_JOB_FETCH_SCHEDULE = exports.AI_MATCH_THRESHOLD = exports.JOB_FRESHNESS_DAYS = exports.REDIS_JOB_CACHE_TTL_SEC = exports.REDIS_DB = exports.JWT_REFRESH_EXPIRES_IN = exports.JWT_EXPIRES_IN = exports.API_VERSION = void 0;
exports.API_VERSION = 'v1';
exports.JWT_EXPIRES_IN = '7d';
exports.JWT_REFRESH_EXPIRES_IN = '30d';
exports.REDIS_DB = 0;
exports.REDIS_JOB_CACHE_TTL_SEC = 3600;
exports.JOB_FRESHNESS_DAYS = 10;
exports.AI_MATCH_THRESHOLD = 50;
exports.CRON_JOB_FETCH_SCHEDULE = '0 * * * *';
exports.CRON_CACHE_WARM_SCHEDULE = '0 */6 * * *';
exports.CRON_ALERT_SCHEDULE = '*/15 * * * *';
exports.ALERT_PUSH_MAX_PER_RUN = 5;
exports.SMTP_HOST = 'smtp.gmail.com';
exports.SMTP_PORT = 587;
exports.EMAIL_FROM = 'Job Hunter <noreply@jobhunter.com>';
exports.RAPIDAPI_JSEARCH_HOST = 'jsearch.p.rapidapi.com';
exports.RAPIDAPI_LINKEDIN_HOST = 'linkedin-data-api.p.rapidapi.com';
exports.ARBEITNOW_API_URL = 'https://www.arbeitnow.com/api/job-board-api';
exports.THEIRSTACK_API_URL = 'https://api.theirstack.com/v1/jobs/search';
exports.ADZUNA_COUNTRY = 'in';
exports.PUPPETEER_HEADLESS = true;
exports.SCRAPER_TIMEOUT_MS = 30_000;
exports.RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) > 0
    ? Number(process.env.RATE_LIMIT_WINDOW_MS)
    : 15 * 60 * 1000;
exports.RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) > 0
    ? Number(process.env.RATE_LIMIT_MAX_REQUESTS)
    : 600;
