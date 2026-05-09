"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
dotenv_1.default.config();
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    PORT: zod_1.z.string().default('5000').transform(Number),
    API_VERSION: zod_1.z.string().default('v1'),
    CLIENT_URL: zod_1.z.string().default('http://localhost:3000'),
    MONGODB_URI: zod_1.z.string(),
    REDIS_HOST: zod_1.z.string().default('localhost'),
    REDIS_PORT: zod_1.z.string().default('6379').transform(Number),
    REDIS_USERNAME: zod_1.z.string().optional(),
    REDIS_PASSWORD: zod_1.z.string().optional(),
    REDIS_DB: zod_1.z.string().default('0').transform(Number),
    REDIS_JOB_CACHE_TTL: zod_1.z.string().default('3600').transform(Number),
    REDIS_TLS: zod_1.z.string().default('auto').transform((v) => v),
    JWT_SECRET: zod_1.z.string().min(32),
    JWT_EXPIRES_IN: zod_1.z.string().default('7d'),
    JWT_REFRESH_SECRET: zod_1.z.string().min(32),
    JWT_REFRESH_EXPIRES_IN: zod_1.z.string().default('30d'),
    GOOGLE_CLIENT_ID: zod_1.z.string().optional(),
    GOOGLE_CLIENT_SECRET: zod_1.z.string().optional(),
    GOOGLE_CALLBACK_URL: zod_1.z.string().optional(),
    GOOGLE_ANDROID_CLIENT_ID: zod_1.z.string().optional(),
    GOOGLE_IOS_CLIENT_ID: zod_1.z.string().optional(),
    ADZUNA_APP_ID: zod_1.z.string().optional(),
    ADZUNA_APP_KEY: zod_1.z.string().optional(),
    ADZUNA_COUNTRY: zod_1.z.string().default('in'),
    SERPAPI_KEY: zod_1.z.string().optional(),
    RAPIDAPI_KEY: zod_1.z.string().optional(),
    RAPIDAPI_JSEARCH_HOST: zod_1.z.string().default('jsearch.p.rapidapi.com'),
    RAPIDAPI_LINKEDIN_HOST: zod_1.z.string().default('linkedin-data-api.p.rapidapi.com'),
    ANTHROPIC_API_KEY: zod_1.z.string().optional(),
    AI_MATCH_THRESHOLD: zod_1.z.string().default('50').transform(Number),
    CRON_JOB_FETCH_SCHEDULE: zod_1.z.string().default('0 * * * *'),
    CRON_CACHE_WARM_SCHEDULE: zod_1.z.string().default('0 */6 * * *'),
    CRON_ENABLED: zod_1.z.string().default('true').transform((v) => v === 'true'),
    JOB_FRESHNESS_DAYS: zod_1.z.string().default('10').transform(Number),
    SMTP_HOST: zod_1.z.string().optional(),
    SMTP_PORT: zod_1.z.string().default('587').transform(Number),
    SMTP_USER: zod_1.z.string().optional(),
    SMTP_PASS: zod_1.z.string().optional(),
    EMAIL_FROM: zod_1.z.string().default('Job Hunter <noreply@jobhunter.com>'),
    RAZORPAY_KEY_ID: zod_1.z.string().optional(),
    RAZORPAY_KEY_SECRET: zod_1.z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: zod_1.z.string().optional(),
    RAZORPAY_TEST_KEY_ID: zod_1.z.string().optional(),
    RAZORPAY_TEST_KEY_SECRET: zod_1.z.string().optional(),
    RAZORPAY_TEST_WEBHOOK_SECRET: zod_1.z.string().optional(),
    STRIPE_SECRET_KEY: zod_1.z.string().optional(),
    STRIPE_WEBHOOK_SECRET: zod_1.z.string().optional(),
    FIREBASE_SERVICE_ACCOUNT_JSON: zod_1.z.string().optional(),
    FIREBASE_SERVICE_ACCOUNT_PATH: zod_1.z.string().optional(),
    FIREBASE_PROJECT_ID: zod_1.z.string().optional(),
    CRON_ALERT_SCHEDULE: zod_1.z.string().default('*/15 * * * *'),
    ALERT_PUSH_MAX_PER_RUN: zod_1.z.string().default('5').transform(Number),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.format());
    throw new Error('Invalid environment configuration');
}
exports.env = parsed.data;
