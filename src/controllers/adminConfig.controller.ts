import { Response } from 'express';
import axios from 'axios';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import {
  deleteAppConfig,
  getAppConfig,
  listAppConfig,
  setAppConfig,
} from '../services/config/config.service';
import { CONFIG_REGISTRY } from '../services/config/configRegistry';
import { AppConfig, type AppConfigCategory } from '../models/AppConfig';
import {
  ADZUNA_COUNTRY,
  OPENWEBNINJA_JSEARCH_URL,
  SMTP_HOST,
  SMTP_PORT,
} from '../config/constants';
import { logger } from '../utils/logger';

const VALID_CATEGORIES: AppConfigCategory[] = [
  'job-board',
  'payment',
  'cloudinary',
  'email',
  'firebase',
  'cron',
  'ai',
  'misc',
];

const KEY_REGEX = /^[A-Z][A-Z0-9_]{0,79}$/;

/**
 * Keys that are auto-projected from another admin surface — direct
 * /config edits on these would be clobbered on the next sync. Surface
 * the source surface in the UI so the operator knows where to actually
 * make the change.
 */
const MANAGED_KEYS: Record<string, { surface: string; href: string }> = {
  GEMINI_API_KEY: { surface: '/ai page (AiKey routing)', href: '/ai' },
  ANTHROPIC_API_KEY: { surface: '/ai page (AiKey routing)', href: '/ai' },
  GROQ_API_KEY: { surface: '/ai page (AiKey routing)', href: '/ai' },
};

/**
 * Map the service's AppConfigSummary onto the shape the admin app
 * expects. The admin UI never sees plaintext for secrets — only the
 * `hasValue` flag and a masked preview suitable for an "info" hint.
 */
const toEntry = (
  row: Awaited<ReturnType<typeof listAppConfig>>[number],
  updatedAtFallback?: Date,
) => ({
  key: row.key,
  category: row.category,
  isSecret: row.isSecret,
  // For non-secret rows we surface the actual value; for secrets only
  // the hasValue flag is meaningful (the UI shows "••••" + an info chip).
  value: row.isSecret ? undefined : row.preview ?? undefined,
  hasValue: row.hasValue,
  notes: row.notes,
  updatedAt: (row.updatedAt ?? updatedAtFallback ?? new Date()).toISOString(),
  managedBy: MANAGED_KEYS[row.key],
});

export const listConfig = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    const rows = await listAppConfig();
    res.json({ entries: rows.map((r) => toEntry(r)) });
  },
);

export const upsertConfig = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const { key, category, isSecret, value, notes } = req.body ?? {};

    if (typeof key !== 'string' || !KEY_REGEX.test(key)) {
      throw ApiError.badRequest(
        'Invalid key. Use UPPER_SNAKE_CASE, must start with a letter, max 80 chars.',
      );
    }
    if (!VALID_CATEGORIES.includes(category)) {
      throw ApiError.badRequest(
        `Invalid category. Allowed: ${VALID_CATEGORIES.join(', ')}`,
      );
    }
    if (typeof isSecret !== 'boolean') {
      throw ApiError.badRequest('isSecret must be a boolean');
    }

    const existing = await AppConfig.findOne({ key }).lean();

    // Value handling:
    //  - new entry: value is required (secret or not)
    //  - existing secret + empty value: keep existing ciphertext
    //  - existing non-secret + empty value: empty allowed (admin chose blank)
    if (!existing) {
      if (typeof value !== 'string' || value.length === 0) {
        throw ApiError.badRequest('Value is required for new config entries.');
      }
    }

    const wantsValueWrite =
      typeof value === 'string' && value.length > 0;

    if (wantsValueWrite || (!isSecret && existing)) {
      // Either user supplied a fresh value, or this is a non-secret edit
      // where empty string is a valid stored value.
      await setAppConfig({
        key,
        category,
        isSecret,
        value: value ?? '',
        notes: typeof notes === 'string' ? notes : undefined,
        updatedBy: req.user?.id,
      });
    } else {
      // Existing secret, value omitted → only update metadata (category,
      // notes, isSecret-flag). Use Mongo directly since the service
      // always rewrites the value slot.
      await AppConfig.updateOne(
        { key },
        {
          $set: {
            category,
            isSecret,
            notes,
            updatedBy: req.user?.id,
          },
        },
      );
    }

    const all = await listAppConfig();
    const saved = all.find((r) => r.key === key);
    if (!saved) throw ApiError.internal('Saved entry vanished');
    res.json(toEntry(saved));
  },
);

export const removeConfig = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const key = req.params.key;
    if (typeof key !== 'string' || !key) throw ApiError.badRequest('Key is required');
    await deleteAppConfig(key);
    res.json({ ok: true });
  },
);

type ProbeResult = { ok: boolean; detail: string };

/**
 * Per-category deep probes. Each returns `ok=false` with a short
 * explanation when the upstream rejects the credential, and `ok=true`
 * with a latency hint on success. Probes deliberately use the lightest
 * read-only endpoint each provider exposes so a misconfigured key never
 * triggers a billable side effect.
 */
const PROBES: Record<string, () => Promise<ProbeResult>> = {
  // ── Adzuna: single-result job search against the configured country ─
  ADZUNA_APP_ID: async () => probeAdzuna(),
  ADZUNA_APP_KEY: async () => probeAdzuna(),

  // ── SerpAPI: account info endpoint (no search credit charged) ──────
  SERPAPI_KEY: async () => {
    const key = getAppConfig('SERPAPI_KEY');
    if (!key) return { ok: false, detail: 'SERPAPI_KEY not set' };
    const r = await axios.get('https://serpapi.com/account', {
      params: { api_key: key },
      timeout: 8000,
      validateStatus: () => true,
    });
    return r.status === 200
      ? { ok: true, detail: `account ok (plan: ${r.data?.plan_name ?? 'unknown'})` }
      : { ok: false, detail: `serpapi returned ${r.status}: ${truncate(r.data?.error)}` };
  },

  // ── OpenWebNinja JSearch v2: single search smoke-test ──────────────
  OPENWEBNINJA_API_KEY: async () => {
    const key = getAppConfig('OPENWEBNINJA_API_KEY');
    if (!key) return { ok: false, detail: 'OPENWEBNINJA_API_KEY not set' };
    const r = await axios.get(OPENWEBNINJA_JSEARCH_URL, {
      params: { query: 'developer', num_pages: '1' },
      headers: { 'X-API-Key': key, Accept: '*/*' },
      timeout: 12000,
      validateStatus: () => true,
    });
    return r.status === 200
      ? { ok: true, detail: `JSearch returned ${r.data?.data?.length ?? 0} hits` }
      : { ok: false, detail: `openwebninja returned ${r.status}` };
  },

  // ── Legacy RapidAPI JSearch: fallback only ─────────────────────────
  RAPIDAPI_KEY: async () => {
    const key = getAppConfig('RAPIDAPI_KEY');
    if (!key) return { ok: false, detail: 'RAPIDAPI_KEY not set' };
    // The scraper now uses OpenWebNinja; the RapidAPI key is only kept
    // as a fallback. Probing it would consume one of the rare free
    // requests on the old plan — instead, just confirm the secret is
    // present without firing a real search.
    return { ok: true, detail: 'present (legacy fallback — OPENWEBNINJA_API_KEY preferred)' };
  },

  // ── Gemini: models list (free) ──────────────────────────────────────
  GEMINI_API_KEY: async () => {
    const key = getAppConfig('GEMINI_API_KEY');
    if (!key) return { ok: false, detail: 'GEMINI_API_KEY not set' };
    const r = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { timeout: 8000, validateStatus: () => true },
    );
    return r.status === 200
      ? { ok: true, detail: `gemini ok (${(r.data?.models?.length ?? 0)} models)` }
      : { ok: false, detail: `gemini returned ${r.status}` };
  },

  // ── Anthropic: messages with 1-token limit ──────────────────────────
  ANTHROPIC_API_KEY: async () => {
    const key = getAppConfig('ANTHROPIC_API_KEY');
    if (!key) return { ok: false, detail: 'ANTHROPIC_API_KEY not set' };
    if (!key.startsWith('sk-ant-')) {
      return { ok: false, detail: 'key does not look like an Anthropic key (sk-ant-…)' };
    }
    const r = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      },
      {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 10000,
        validateStatus: () => true,
      },
    );
    return r.status === 200
      ? { ok: true, detail: 'anthropic auth ok' }
      : { ok: false, detail: `anthropic returned ${r.status}: ${truncate(r.data?.error?.message)}` };
  },

  // ── Cloudinary: usage endpoint (signed) ─────────────────────────────
  CLOUDINARY_CLOUD_NAME: async () => probeCloudinary(),
  CLOUDINARY_API_KEY: async () => probeCloudinary(),
  CLOUDINARY_API_SECRET: async () => probeCloudinary(),

  // ── Razorpay: orders.list with count=1 (read-only) ──────────────────
  RAZORPAY_KEY_ID: async () => probeRazorpay('live'),
  RAZORPAY_KEY_SECRET: async () => probeRazorpay('live'),
  RAZORPAY_TEST_KEY_ID: async () => probeRazorpay('test'),
  RAZORPAY_TEST_KEY_SECRET: async () => probeRazorpay('test'),

  // ── SMTP: nodemailer verify ─────────────────────────────────────────
  SMTP_USER: async () => probeSmtp(),
  SMTP_PASS: async () => probeSmtp(),

  // ── Firebase: parse + project-id sanity ─────────────────────────────
  FIREBASE_SERVICE_ACCOUNT_JSON: async () => {
    const blob = getAppConfig('FIREBASE_SERVICE_ACCOUNT_JSON');
    if (!blob) return { ok: false, detail: 'FIREBASE_SERVICE_ACCOUNT_JSON not set' };
    try {
      const parsed = JSON.parse(blob) as Record<string, string>;
      if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
        return { ok: false, detail: 'JSON missing project_id/client_email/private_key' };
      }
      return { ok: true, detail: `parsed ok (project ${parsed.project_id})` };
    } catch (err) {
      return { ok: false, detail: `invalid JSON: ${(err as Error).message}` };
    }
  },
  FIREBASE_PROJECT_ID: async () => {
    const id = getAppConfig('FIREBASE_PROJECT_ID');
    return id
      ? { ok: true, detail: `project_id = ${id}` }
      : { ok: false, detail: 'FIREBASE_PROJECT_ID not set' };
  },
};

const probeAdzuna = async (): Promise<ProbeResult> => {
  const id = getAppConfig('ADZUNA_APP_ID');
  const key = getAppConfig('ADZUNA_APP_KEY');
  if (!id || !key) return { ok: false, detail: 'ADZUNA_APP_ID / ADZUNA_APP_KEY missing' };
  const r = await axios.get(
    `https://api.adzuna.com/v1/api/jobs/${ADZUNA_COUNTRY}/search/1`,
    {
      params: { app_id: id, app_key: key, results_per_page: 1, what: 'developer' },
      timeout: 8000,
      validateStatus: () => true,
    },
  );
  return r.status === 200
    ? { ok: true, detail: `adzuna ok (${r.data?.count ?? '?'} total results)` }
    : { ok: false, detail: `adzuna returned ${r.status}` };
};

const probeCloudinary = async (): Promise<ProbeResult> => {
  const cloudName = getAppConfig('CLOUDINARY_CLOUD_NAME');
  const apiKey = getAppConfig('CLOUDINARY_API_KEY');
  const apiSecret = getAppConfig('CLOUDINARY_API_SECRET');
  if (!cloudName || !apiKey || !apiSecret) {
    return { ok: false, detail: 'Cloudinary credentials incomplete' };
  }
  const r = await axios.get(
    `https://api.cloudinary.com/v1_1/${cloudName}/usage`,
    {
      auth: { username: apiKey, password: apiSecret },
      timeout: 8000,
      validateStatus: () => true,
    },
  );
  return r.status === 200
    ? { ok: true, detail: `cloudinary ok (plan: ${r.data?.plan ?? 'unknown'})` }
    : { ok: false, detail: `cloudinary returned ${r.status}` };
};

const probeRazorpay = async (mode: 'live' | 'test'): Promise<ProbeResult> => {
  const id = getAppConfig(mode === 'live' ? 'RAZORPAY_KEY_ID' : 'RAZORPAY_TEST_KEY_ID');
  const secret = getAppConfig(
    mode === 'live' ? 'RAZORPAY_KEY_SECRET' : 'RAZORPAY_TEST_KEY_SECRET',
  );
  if (!id || !secret) {
    return { ok: false, detail: `Razorpay ${mode} credentials incomplete` };
  }
  const r = await axios.get('https://api.razorpay.com/v1/orders', {
    params: { count: 1 },
    auth: { username: id, password: secret },
    timeout: 8000,
    validateStatus: () => true,
  });
  return r.status === 200
    ? { ok: true, detail: `razorpay ${mode} auth ok` }
    : { ok: false, detail: `razorpay ${mode} returned ${r.status}` };
};

const probeSmtp = async (): Promise<ProbeResult> => {
  const user = getAppConfig('SMTP_USER');
  const pass = getAppConfig('SMTP_PASS');
  if (!user || !pass) return { ok: false, detail: 'SMTP_USER / SMTP_PASS missing' };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodemailer = require('nodemailer') as typeof import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user, pass },
  });
  try {
    await transporter.verify();
    return { ok: true, detail: `smtp ok (${SMTP_HOST}:${SMTP_PORT})` };
  } catch (err) {
    return { ok: false, detail: `smtp verify failed: ${(err as Error).message}` };
  } finally {
    transporter.close();
  }
};

const truncate = (s: unknown, max = 80): string => {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

/**
 * Probe a configured upstream using the credential stored at [key]. The
 * specific probe is picked from PROBES — when no per-key probe exists we
 * fall back to the cheap "value present?" check so the UI never breaks.
 */
export const probeConfig = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const key = req.params.key;
    if (typeof key !== 'string' || !key) throw ApiError.badRequest('Key is required');
    const start = Date.now();
    const all = await listAppConfig();
    const row = all.find((r) => r.key === key);
    if (!row) throw ApiError.notFound(`Config "${key}" not found`);
    if (!row.hasValue) {
      res.json({
        ok: false,
        latencyMs: Date.now() - start,
        detail: 'No value stored',
      });
      return;
    }

    const probe = PROBES[key];
    if (!probe) {
      res.json({
        ok: true,
        latencyMs: Date.now() - start,
        detail: 'Value present (no deep probe for this key)',
      });
      return;
    }
    try {
      const result = await probe();
      res.json({
        ok: result.ok,
        latencyMs: Date.now() - start,
        detail: result.detail,
      });
    } catch (err) {
      logger.warn(`probe ${key} threw: ${(err as Error).message}`);
      res.json({
        ok: false,
        latencyMs: Date.now() - start,
        detail: `probe failed: ${(err as Error).message}`,
      });
    }
  },
);

/**
 * Catalog of every config key the backend knows about. Powers the
 * "Suggest a key" dropdown on the admin /config page so an operator
 * doesn't have to remember the exact key name, category or secret flag.
 * Entries already populated in the DB are flagged so the UI can hide
 * them from the dropdown.
 */
export const listConfigRegistry = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    const existing = new Set(
      (await AppConfig.find({}, { key: 1 }).lean()).map((r) => r.key),
    );
    res.json({
      entries: CONFIG_REGISTRY.map((e) => ({
        key: e.key,
        category: e.category,
        isSecret: e.isSecret,
        description: e.description,
        defaultValue: e.defaultValue,
        usedBy: e.usedBy,
        alreadyConfigured: existing.has(e.key),
      })),
    });
  },
);
