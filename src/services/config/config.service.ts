import { AppConfig, type AppConfigCategory } from '../../models/AppConfig';
import { decryptSecret, encryptSecret } from '../../utils/aesCrypto';
import { logger } from '../../utils/logger';

/**
 * In-memory cache of DB-backed runtime config. Boot does one `preload()`
 * pass so reads from hot paths (per-request Cloudinary signing, per-job
 * Adzuna fetch, etc.) never touch Mongo. Admin writes invalidate the
 * cached entry, so the next read picks up the new value.
 *
 * Reads fall back to `process.env[KEY]` when a key is missing from the
 * cache — this keeps the codebase usable while we migrate, and on a
 * fresh install (empty DB) the backend still boots from `.env`.
 *
 * Each cache row holds three slots: `test`, `live`, and `legacy`. The
 * active runtime mode (driven by the `RUNTIME_MODE` AppConfig row)
 * selects which slot `getAppConfig` returns first; the legacy slot is
 * the fallback for mode-agnostic keys (e.g. RUNTIME_MODE itself,
 * CRON_ENABLED, RATE_LIMIT_*) and for pre-migration data.
 */
export type RuntimeMode = 'test' | 'live';

export const RUNTIME_MODE_KEY = 'RUNTIME_MODE';
export const DEFAULT_RUNTIME_MODE: RuntimeMode = 'live';

interface CacheRow {
  test: string | null;
  live: string | null;
  legacy: string | null;
}

const cache = new Map<string, CacheRow>();
let preloaded = false;
let activeMode: RuntimeMode = DEFAULT_RUNTIME_MODE;

const emptyRow = (): CacheRow => ({ test: null, live: null, legacy: null });

const setRow = (key: string, row: CacheRow): void => {
  cache.set(key, row);
};

const resolveFromEnv = (key: string): string | null => {
  const fromEnv = process.env[key];
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
};

const decryptOrNull = (key: string, blob?: string | null): string | null => {
  if (!blob) return null;
  try {
    return decryptSecret(blob);
  } catch (err) {
    logger.warn(
      `AppConfig: failed to decrypt slot for "${key}" — falling back`,
      err,
    );
    return null;
  }
};

const parseMode = (raw: string | null | undefined): RuntimeMode => {
  return raw === 'test' ? 'test' : 'live';
};

export const preloadAppConfig = async (): Promise<void> => {
  const rows = await AppConfig.find({})
    .select('+valueEncrypted +testValueEncrypted +liveValueEncrypted')
    .lean();
  cache.clear();
  for (const row of rows) {
    const next = emptyRow();
    if (row.isSecret) {
      next.test = decryptOrNull(row.key, row.testValueEncrypted);
      next.live = decryptOrNull(row.key, row.liveValueEncrypted);
      next.legacy = decryptOrNull(row.key, row.valueEncrypted);
    } else {
      next.test = row.testValue ?? null;
      next.live = row.liveValue ?? null;
      next.legacy = row.value ?? null;
    }
    setRow(row.key, next);
  }
  // Pick up the persisted runtime mode (defaults to 'live' for safety —
  // fresh installs should opt into test mode explicitly).
  activeMode = parseMode(cache.get(RUNTIME_MODE_KEY)?.legacy ?? null);
  preloaded = true;
  logger.info(
    `AppConfig: preloaded ${cache.size} key(s) — runtime mode = ${activeMode}`,
  );
};

/**
 * Returns the active-mode value if present, else the legacy slot, else
 * the env fallback. Returns null when no source has the key.
 */
export const getAppConfig = (key: string): string | null => {
  const row = cache.get(key);
  if (row) {
    const modeValue = row[activeMode];
    if (modeValue) return modeValue;
    if (row.legacy) return row.legacy;
  }
  return resolveFromEnv(key);
};

/**
 * Read a specific slot directly without applying mode fallback. Useful
 * for admin surfaces that need to show / edit a single side.
 */
export const getAppConfigSlot = (
  key: string,
  slot: RuntimeMode | 'legacy',
): string | null => {
  return cache.get(key)?.[slot] ?? null;
};

export const requireAppConfig = (key: string): string => {
  const v = getAppConfig(key);
  if (!v) {
    throw new Error(
      `Missing required config key "${key}". Set it in the admin panel or as an env var.`,
    );
  }
  return v;
};

export const isAppConfigPreloaded = (): boolean => preloaded;

export const getRuntimeMode = (): RuntimeMode => activeMode;

export interface SetAppConfigArgs {
  key: string;
  category: AppConfigCategory;
  isSecret: boolean;
  /** Update the Test slot. Pass `undefined` to leave untouched, `''` to clear. */
  testValue?: string;
  /** Update the Live slot. Pass `undefined` to leave untouched, `''` to clear. */
  liveValue?: string;
  /** Update the mode-agnostic legacy slot (used by RUNTIME_MODE, CRON_ENABLED, etc). */
  legacyValue?: string;
  notes?: string;
  updatedBy?: string;
}

const buildSlotUpdate = (
  isSecret: boolean,
  raw: string | undefined,
  plainField: 'testValue' | 'liveValue' | 'value',
  cipherField: 'testValueEncrypted' | 'liveValueEncrypted' | 'valueEncrypted',
  update: Record<string, unknown>,
  unset: Record<string, ''>,
): void => {
  if (raw === undefined) return; // leave slot untouched
  if (raw === '') {
    // Clear both sides of the slot
    unset[plainField] = '';
    unset[cipherField] = '';
    return;
  }
  if (isSecret) {
    update[cipherField] = encryptSecret(raw);
    unset[plainField] = '';
  } else {
    update[plainField] = raw;
    unset[cipherField] = '';
  }
};

export const setAppConfig = async (args: SetAppConfigArgs): Promise<void> => {
  const set: Record<string, unknown> = {
    category: args.category,
    isSecret: args.isSecret,
    notes: args.notes,
    updatedBy: args.updatedBy,
  };
  const unset: Record<string, ''> = {};

  buildSlotUpdate(args.isSecret, args.testValue, 'testValue', 'testValueEncrypted', set, unset);
  buildSlotUpdate(args.isSecret, args.liveValue, 'liveValue', 'liveValueEncrypted', set, unset);
  buildSlotUpdate(args.isSecret, args.legacyValue, 'value', 'valueEncrypted', set, unset);

  const op: Record<string, unknown> = { $set: set };
  if (Object.keys(unset).length > 0) op.$unset = unset;

  await AppConfig.findOneAndUpdate({ key: args.key }, op, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

  // Sync cache for this key in-memory so the next read sees the change
  // without waiting for the next preload.
  const row = cache.get(args.key) ?? emptyRow();
  if (args.testValue !== undefined) row.test = args.testValue === '' ? null : args.testValue;
  if (args.liveValue !== undefined) row.live = args.liveValue === '' ? null : args.liveValue;
  if (args.legacyValue !== undefined) row.legacy = args.legacyValue === '' ? null : args.legacyValue;
  setRow(args.key, row);

  if (args.key === RUNTIME_MODE_KEY && args.legacyValue !== undefined) {
    activeMode = parseMode(args.legacyValue);
  }
};

/**
 * Flip the runtime mode atomically. Persists the new value to the
 * `RUNTIME_MODE` AppConfig row and updates the in-memory selector so the
 * next `getAppConfig(...)` call picks the right slot.
 *
 * Callers that hold their own initialised SDK clients (firebase-admin,
 * cloudinary, …) must additionally re-init when the mode flips —
 * `clearAppConfigCache` is *not* enough.
 */
export const setRuntimeMode = async (
  mode: RuntimeMode,
  updatedBy?: string,
): Promise<void> => {
  await setAppConfig({
    key: RUNTIME_MODE_KEY,
    category: 'misc',
    isSecret: false,
    legacyValue: mode,
    notes: 'Active runtime mode — flipped from admin /config page',
    updatedBy,
  });
  activeMode = mode;
  logger.info(`AppConfig: runtime mode → ${mode}`);
};

export const deleteAppConfig = async (key: string): Promise<void> => {
  await AppConfig.deleteOne({ key });
  cache.delete(key);
};

/**
 * Drop the entire in-memory cache and re-load from Mongo. Useful after
 * a bulk import or when an operator suspects drift.
 */
export const clearAppConfigCache = async (): Promise<void> => {
  await preloadAppConfig();
};

const previewOf = (raw: string | null, isSecret: boolean): string | null => {
  if (!raw) return null;
  if (!isSecret) return raw;
  return raw.length <= 4 ? '*'.repeat(raw.length) : `••••${raw.slice(-4)}`;
};

/**
 * Lists all keys with their metadata. Secrets are NEVER decrypted to the
 * caller — only masked previews and `hasValue` flags per slot.
 */
export interface AppConfigSummary {
  key: string;
  category: AppConfigCategory;
  isSecret: boolean;
  hasTestValue: boolean;
  hasLiveValue: boolean;
  hasLegacyValue: boolean;
  testPreview: string | null;
  livePreview: string | null;
  legacyPreview: string | null;
  notes?: string;
  updatedAt: Date;
}

export const listAppConfig = async (): Promise<AppConfigSummary[]> => {
  const rows = await AppConfig.find({})
    .select('+valueEncrypted +testValueEncrypted +liveValueEncrypted')
    .lean();
  return rows.map((row) => {
    const testPlain = row.isSecret
      ? decryptOrNull(row.key, row.testValueEncrypted)
      : row.testValue ?? null;
    const livePlain = row.isSecret
      ? decryptOrNull(row.key, row.liveValueEncrypted)
      : row.liveValue ?? null;
    const legacyPlain = row.isSecret
      ? decryptOrNull(row.key, row.valueEncrypted)
      : row.value ?? null;
    return {
      key: row.key,
      category: row.category,
      isSecret: row.isSecret,
      hasTestValue: Boolean(testPlain),
      hasLiveValue: Boolean(livePlain),
      hasLegacyValue: Boolean(legacyPlain),
      testPreview: previewOf(testPlain, row.isSecret),
      livePreview: previewOf(livePlain, row.isSecret),
      legacyPreview: previewOf(legacyPlain, row.isSecret),
      notes: row.notes,
      updatedAt: row.updatedAt,
    };
  });
};
