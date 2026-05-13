import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { setAppConfig } from '../src/services/config/config.service';
import type { AppConfigCategory } from '../src/models/AppConfig';
import { AppConfig } from '../src/models/AppConfig';
import { logger } from '../src/utils/logger';

/**
 * One-shot migration: copy every admin-managed value from `.env` (and
 * the Firebase service-account JSON file) into the `app_configs`
 * collection. Secrets are encrypted under CRYPTO_MASTER_KEY via the
 * shared `setAppConfig` helper.
 *
 *   npm run seed:config            # idempotent — skip keys already in DB
 *   npm run seed:config -- --force # overwrite existing rows with .env values
 *   npm run seed:config -- --dry   # print the plan, write nothing
 *
 * After a successful run, delete the corresponding entries from .env so
 * the admin panel becomes the single source of truth. The bootstrap
 * keys (MONGODB_URI, REDIS_*, JWT_*, CRYPTO_MASTER_KEY, NODE_ENV, PORT,
 * CLIENT_URL) MUST stay in .env — they are needed before the DB cache
 * is hydrated.
 */

interface SeedEntry {
  key: string;
  category: AppConfigCategory;
  isSecret: boolean;
  /** Optional: when omitted, read from process.env[key]. */
  resolve?: () => string | null | undefined;
  notes?: string;
}

const ENTRIES: SeedEntry[] = [
  // ── Job-board APIs ─────────────────────────────────────
  { key: 'ADZUNA_APP_ID', category: 'job-board', isSecret: false, notes: 'Adzuna application ID — non-secret, used in URL.' },
  { key: 'ADZUNA_APP_KEY', category: 'job-board', isSecret: true },
  { key: 'SERPAPI_KEY', category: 'job-board', isSecret: true },
  { key: 'RAPIDAPI_KEY', category: 'job-board', isSecret: true, notes: 'JSearch + LinkedIn Data API via RapidAPI.' },
  { key: 'THEIRSTACK_API_KEY', category: 'job-board', isSecret: true },

  // ── AI providers ────────────────────────────────────────
  { key: 'ANTHROPIC_API_KEY', category: 'misc', isSecret: true, notes: 'Claude (matcher fallback + intent extraction).' },
  { key: 'GEMINI_API_KEY', category: 'misc', isSecret: true, notes: 'Gemini (default matcher + AI features).' },
  { key: 'AI_PROVIDER', category: 'misc', isSecret: false, notes: '"gemini" or "claude" — controls which provider serves AI features.' },

  // ── Email (SMTP) ───────────────────────────────────────
  { key: 'SMTP_USER', category: 'email', isSecret: false },
  { key: 'SMTP_PASS', category: 'email', isSecret: true, notes: 'Gmail app password — rotate via Google account security.' },

  // ── Razorpay subscriptions ─────────────────────────────
  { key: 'RAZORPAY_KEY_ID', category: 'payment', isSecret: false, notes: 'Live key ID — surfaced to the client.' },
  { key: 'RAZORPAY_KEY_SECRET', category: 'payment', isSecret: true },
  { key: 'RAZORPAY_TEST_KEY_ID', category: 'payment', isSecret: false },
  { key: 'RAZORPAY_TEST_KEY_SECRET', category: 'payment', isSecret: true },
  { key: 'RAZORPAY_WEBHOOK_SECRET', category: 'payment', isSecret: true, notes: 'Required for live webhook verification.' },
  { key: 'RAZORPAY_TEST_WEBHOOK_SECRET', category: 'payment', isSecret: true },

  // ── Cloudinary ─────────────────────────────────────────
  { key: 'CLOUDINARY_CLOUD_NAME', category: 'cloudinary', isSecret: false },
  { key: 'CLOUDINARY_API_KEY', category: 'cloudinary', isSecret: false, notes: 'Public — paired with API secret for signed uploads.' },
  { key: 'CLOUDINARY_API_SECRET', category: 'cloudinary', isSecret: true },

  // ── Firebase ───────────────────────────────────────────
  { key: 'FIREBASE_PROJECT_ID', category: 'firebase', isSecret: false },
  {
    key: 'FIREBASE_SERVICE_ACCOUNT_JSON',
    category: 'firebase',
    isSecret: true,
    notes: 'Full service-account JSON. Replaces the filesystem path approach.',
    resolve: () => {
      // Already in env? use it.
      const direct = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (direct && direct.length > 0) return direct;
      // Else read from the legacy file path and inline the JSON.
      const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
      if (!p) return null;
      try {
        const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
        return fs.readFileSync(abs, 'utf8');
      } catch (err) {
        logger.warn(`seed: failed to read firebase service account from ${p}: ${(err as Error).message}`);
        return null;
      }
    },
  },

  // ── WhatsApp (MSG91) — optional, only seed if present ──
  { key: 'MSG91_AUTH_KEY', category: 'misc', isSecret: true },
  { key: 'MSG91_WHATSAPP_NUMBER', category: 'misc', isSecret: false },
  { key: 'MSG91_WHATSAPP_TEMPLATE', category: 'misc', isSecret: false },
  { key: 'MSG91_WHATSAPP_NAMESPACE', category: 'misc', isSecret: false },

  // ── Cron toggle (mirrors legacy CRON_ENABLED env) ──────
  { key: 'CRON_ENABLED', category: 'cron', isSecret: false, notes: 'Master kill-switch — "true" or "false".' },
];

const parseArgs = () => {
  const args = new Set<string>();
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith('--')) args.add(raw.slice(2));
  }
  return {
    force: args.has('force'),
    dry: args.has('dry') || args.has('dry-run'),
  };
};

(async () => {
  const { force, dry } = parseArgs();
  logger.info(
    `seed-config: starting${force ? ' [force]' : ''}${dry ? ' [dry-run]' : ''}`,
  );

  if (!process.env.CRYPTO_MASTER_KEY) {
    logger.error('CRYPTO_MASTER_KEY is required — secrets cannot be encrypted without it.');
    process.exit(1);
  }

  await connectDatabase();

  const existing = await AppConfig.find({}).select('key').lean();
  const existingKeys = new Set(existing.map((r) => r.key));

  let written = 0;
  let skipped = 0;
  let missing = 0;

  for (const entry of ENTRIES) {
    const value = entry.resolve
      ? entry.resolve()
      : process.env[entry.key];

    if (!value || value.length === 0) {
      logger.info(`  · ${entry.key} → not set in env, skipping`);
      missing += 1;
      continue;
    }

    if (existingKeys.has(entry.key) && !force) {
      logger.info(`  · ${entry.key} → already in DB, skipping (use --force to overwrite)`);
      skipped += 1;
      continue;
    }

    if (dry) {
      const preview = entry.isSecret ? `••••${value.slice(-4)}` : value;
      logger.info(`  ✎ ${entry.key} = ${preview}  [${entry.category}${entry.isSecret ? ', secret' : ''}]`);
      written += 1;
      continue;
    }

    await setAppConfig({
      key: entry.key,
      category: entry.category,
      isSecret: entry.isSecret,
      value,
      notes: entry.notes,
    });
    logger.info(`  ✓ ${entry.key} → written (${entry.category}${entry.isSecret ? ', encrypted' : ''})`);
    written += 1;
  }

  logger.info(
    `seed-config: ${written} written, ${skipped} skipped, ${missing} missing from env`,
  );

  await disconnectDatabase();
  process.exit(0);
})().catch((err) => {
  logger.error('seed-config failed', err);
  process.exit(1);
});
