import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Environment schema — secrets and per-deployment overrides only.
 *
 * Project-wide constants (cron schedules, JWT lifetimes, freshness
 * windows, SMTP host, third-party API hosts, etc.) live in
 * `src/config/constants.ts` and are imported directly. Don't add
 * non-sensitive defaults here.
 */
const envSchema = z.object({
  // ── Runtime ─────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000').transform(Number),
  CLIENT_URL: z.string().default('http://localhost:3000'),

  // ── MongoDB ─────────────────────────────────────────────
  MONGODB_URI: z.string(),

  // ── Redis ───────────────────────────────────────────────
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379').transform(Number),
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z.string().default('auto'),

  // ── JWT (secrets only — lifetimes are in constants.ts) ──
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),

  // ── Job-board APIs (keys only) ──────────────────────────
  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  SERPAPI_KEY: z.string().optional(),
  RAPIDAPI_KEY: z.string().optional(),
  THEIRSTACK_API_KEY: z.string().optional(),

  // ── AI ──────────────────────────────────────────────────
  ANTHROPIC_API_KEY: z.string().optional(),

  // ── Cron toggle (per-env: prod=true, tests=false) ───────
  CRON_ENABLED: z.string().default('true').transform((v) => v === 'true'),

  // ── Email (credentials only) ────────────────────────────
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // ── Subscriptions (Razorpay primary, Stripe optional) ───
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Test keys — only honoured for debug-build clients in non-prod envs.
  RAZORPAY_TEST_KEY_ID: z.string().optional(),
  RAZORPAY_TEST_KEY_SECRET: z.string().optional(),
  RAZORPAY_TEST_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // ── Firebase (FCM push + Auth ID-token verification) ───
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),

  // ── Cloudinary (file storage) ───────────────────────────
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
export type Env = typeof env;
