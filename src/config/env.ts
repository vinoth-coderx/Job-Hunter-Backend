import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000').transform(Number),
  API_VERSION: z.string().default('v1'),
  CLIENT_URL: z.string().default('http://localhost:3000'),

  MONGODB_URI: z.string(),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379').transform(Number),
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.string().default('0').transform(Number),
  REDIS_JOB_CACHE_TTL: z.string().default('3600').transform(Number),
  REDIS_TLS: z.string().default('auto').transform((v) => v),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),
  GOOGLE_ANDROID_CLIENT_ID: z.string().optional(),
  GOOGLE_IOS_CLIENT_ID: z.string().optional(),

  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  ADZUNA_COUNTRY: z.string().default('in'),

  SERPAPI_KEY: z.string().optional(),

  RAPIDAPI_KEY: z.string().optional(),
  RAPIDAPI_JSEARCH_HOST: z.string().default('jsearch.p.rapidapi.com'),
  RAPIDAPI_LINKEDIN_HOST: z.string().default('linkedin-data-api.p.rapidapi.com'),

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MATCH_THRESHOLD: z.string().default('50').transform(Number),

  CRON_JOB_FETCH_SCHEDULE: z.string().default('0 * * * *'),
  CRON_CACHE_WARM_SCHEDULE: z.string().default('0 */6 * * *'),
  CRON_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  JOB_FRESHNESS_DAYS: z.string().default('10').transform(Number),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().default('587').transform(Number),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('Job Hunter <noreply@jobhunter.com>'),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
export type Env = typeof env;
