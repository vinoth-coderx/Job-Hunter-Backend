import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Bootstrap-essential environment variables.
 *
 * Only values needed BEFORE the AppConfig DB cache is hydrated live
 * here: what the process must know to connect to Mongo, decrypt
 * AppConfig secrets, accept incoming requests, and sign JWTs.
 *
 * Everything else (Cloudinary, Razorpay, Stripe, SMTP, Firebase,
 * job-board APIs, AI provider keys, cron toggle, …) lives in the
 * admin-managed `app_configs` collection and is read via
 * `getAppConfig(KEY)`. Those keys are still respected as `process.env`
 * fallbacks at runtime — `getAppConfig` checks `process.env[KEY]` on
 * cache miss — so a fresh install can boot from a `.env` file before
 * the admin populates the DB.
 *
 * Project-wide non-secret constants (cron schedules, JWT lifetimes,
 * freshness windows, SMTP host/port, third-party API hosts, etc.) live
 * in `src/config/constants.ts` and are imported directly.
 */
const envSchema = z.object({
  // ── Runtime ─────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000').transform(Number),
  CLIENT_URL: z.string().default('http://localhost:3000'),

  // ── MongoDB (must connect before we can read AppConfig) ─
  // MONGODB_URI is the test/dev cluster (used when NODE_ENV !== 'production').
  // MONGODB_URI_PROD is the production cluster (used only when NODE_ENV === 'production').
  // If MONGODB_URI_PROD is missing in production, the loader falls back to MONGODB_URI.
  MONGODB_URI: z.string(),
  MONGODB_URI_PROD: z.string().optional(),

  // ── Redis (queues + caches; needed before any request) ──
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379').transform(Number),
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z.string().default('auto'),

  // ── JWT signing secrets (must exist to mint a token) ────
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),

  // ── At-rest encryption master key ───────────────────────
  // Required to decrypt admin-managed AppConfig secrets (Cloudinary
  // creds, Razorpay keys, …). Optional in dev so the backend still
  // boots without it; getAppConfig falls back to process.env for any
  // key that hasn't been migrated. Generate with: `openssl rand -hex 32`.
  CRYPTO_MASTER_KEY: z.string().length(64).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
export type Env = typeof env;
