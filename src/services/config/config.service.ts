import { AppConfig, type AppConfigCategory } from '../../models/AppConfig';
import { decryptSecret, encryptSecret } from '../../utils/aesCrypto';
import { logger } from '../../utils/logger';
import {
  getConnectionForMode,
  currentRuntimeMode,
  type RuntimeMode,
} from '../../config/dbConnections';

export type { RuntimeMode };

/**
 * In-memory cache of AppConfig keyed by runtime mode. Each mode keeps
 * its own Map<key, value | null> populated from that mode's Mongo at
 * boot (and refreshed on admin writes). The cache lookup is mode-aware
 * via `currentRuntimeMode()`, which itself is bound by per-request
 * AsyncLocalStorage from the X-Runtime-Mode middleware.
 *
 * AppConfig is single-slot per row now — the old test/live/legacy slot
 * dichotomy is redundant since each mode has its own DB. Reads fall
 * through legacy slots for migration safety, but writes only ever touch
 * `value` / `valueEncrypted`.
 */
const caches: Record<RuntimeMode, Map<string, string | null>> = {
  test: new Map(),
  live: new Map(),
};
const preloaded: Record<RuntimeMode, boolean> = { test: false, live: false };

const resolveFromEnv = (key: string): string | null => {
  const fromEnv = process.env[key];
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
};

const decryptOrNull = (key: string, blob?: string | null): string | null => {
  if (!blob) return null;
  try {
    return decryptSecret(blob);
  } catch (err) {
    logger.warn(`AppConfig: decrypt failed for "${key}"`, err);
    return null;
  }
};

/**
 * Pick whichever slot has a value, in this preference order:
 *   value (canonical) → liveValue / testValue (migrated rows)
 * Used when a row exists in legacy split-slot form.
 */
const pickSlot = (row: {
  isSecret: boolean;
  value?: string;
  valueEncrypted?: string;
  liveValue?: string;
  liveValueEncrypted?: string;
  testValue?: string;
  testValueEncrypted?: string;
}, key: string): string | null => {
  if (row.isSecret) {
    return (
      decryptOrNull(key, row.valueEncrypted) ??
      decryptOrNull(key, row.liveValueEncrypted) ??
      decryptOrNull(key, row.testValueEncrypted)
    );
  }
  return row.value ?? row.liveValue ?? row.testValue ?? null;
};

const preloadMode = async (mode: RuntimeMode): Promise<void> => {
  const conn = getConnectionForMode(mode);
  const Model = conn.models.AppConfig ?? conn.model('AppConfig', AppConfig.schema);
  const rows = (await Model.find({})
    .select('+valueEncrypted +testValueEncrypted +liveValueEncrypted')
    .lean()) as unknown as Array<{
    key: string;
    isSecret: boolean;
    value?: string;
    valueEncrypted?: string;
    testValue?: string;
    testValueEncrypted?: string;
    liveValue?: string;
    liveValueEncrypted?: string;
  }>;
  const cache = caches[mode];
  cache.clear();
  for (const row of rows) {
    cache.set(row.key, pickSlot(row, row.key));
  }
  preloaded[mode] = true;
  logger.info(`AppConfig[${mode}]: preloaded ${cache.size} key(s)`);
};

export const preloadAppConfig = async (): Promise<void> => {
  // Preload both DBs in parallel at boot. Failure in one mode is
  // non-fatal — services fall back to env on cache miss.
  await Promise.allSettled([preloadMode('test'), preloadMode('live')]);
};

/**
 * Returns the active-mode value if present, else the env fallback.
 * Active mode is read fresh on every call via AsyncLocalStorage.
 */
export const getAppConfig = (key: string): string | null => {
  const mode = currentRuntimeMode();
  const cache = caches[mode];
  if (cache.has(key)) return cache.get(key) ?? null;
  return resolveFromEnv(key);
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

export const isAppConfigPreloaded = (): boolean =>
  preloaded.test || preloaded.live;

export const getRuntimeMode = (): RuntimeMode => currentRuntimeMode();

export interface SetAppConfigArgs {
  key: string;
  category: AppConfigCategory;
  value: string;
  isSecret: boolean;
  notes?: string;
  updatedBy?: string;
}

/**
 * Persist a config value to the ACTIVE runtime mode's DB. Test-mode
 * requests write into the test Mongo's `app_configs`; live-mode
 * requests write into the live Mongo's. Operators see exactly the rows
 * that exist in the mode they're currently viewing.
 */
export const setAppConfig = async (args: SetAppConfigArgs): Promise<void> => {
  const update: Record<string, unknown> = {
    category: args.category,
    isSecret: args.isSecret,
    notes: args.notes,
    updatedBy: args.updatedBy,
  };
  if (args.isSecret) {
    update.valueEncrypted = encryptSecret(args.value);
    update.value = undefined;
  } else {
    update.value = args.value;
    update.valueEncrypted = undefined;
  }
  // Clear any legacy split-slot fields when overwriting so the row
  // collapses back to single-slot form.
  const unset = {
    testValue: '' as const,
    testValueEncrypted: '' as const,
    liveValue: '' as const,
    liveValueEncrypted: '' as const,
  };
  await AppConfig.findOneAndUpdate(
    { key: args.key },
    { $set: update, $unset: unset },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const mode = currentRuntimeMode();
  caches[mode].set(args.key, args.value);
};

export const deleteAppConfig = async (key: string): Promise<void> => {
  await AppConfig.deleteOne({ key });
  const mode = currentRuntimeMode();
  caches[mode].delete(key);
};

export const clearAppConfigCache = async (): Promise<void> => {
  await preloadAppConfig();
};

const previewOf = (raw: string | null, isSecret: boolean): string | null => {
  if (!raw) return null;
  if (!isSecret) return raw;
  return raw.length <= 4 ? '*'.repeat(raw.length) : `••••${raw.slice(-4)}`;
};

export interface AppConfigSummary {
  key: string;
  category: AppConfigCategory;
  isSecret: boolean;
  hasValue: boolean;
  preview: string | null;
  notes?: string;
  updatedAt: Date;
}

/**
 * Lists all keys for the ACTIVE mode. Secrets are never decrypted
 * outside the cache — `preview` carries a masked hint built from the
 * stored plaintext (cache resident) when present.
 */
export const listAppConfig = async (): Promise<AppConfigSummary[]> => {
  const rows = await AppConfig.find({})
    .select('+valueEncrypted +testValueEncrypted +liveValueEncrypted')
    .lean();
  return rows.map((row) => {
    const plain = pickSlot(row as Parameters<typeof pickSlot>[0], row.key);
    return {
      key: row.key,
      category: row.category,
      isSecret: row.isSecret,
      hasValue: Boolean(plain),
      preview: previewOf(plain, row.isSecret),
      notes: row.notes,
      updatedAt: row.updatedAt,
    };
  });
};
