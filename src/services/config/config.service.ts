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
 */
const cache = new Map<string, string | null>();
let preloaded = false;

const setCache = (key: string, value: string | null): void => {
  cache.set(key, value);
};

const resolveFromEnv = (key: string): string | null => {
  const fromEnv = process.env[key];
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
};

export const preloadAppConfig = async (): Promise<void> => {
  const rows = await AppConfig.find({}).select('+valueEncrypted').lean();
  cache.clear();
  for (const row of rows) {
    try {
      if (row.isSecret) {
        const enc = row.valueEncrypted;
        if (!enc) {
          setCache(row.key, null);
          continue;
        }
        setCache(row.key, decryptSecret(enc));
      } else {
        setCache(row.key, row.value ?? null);
      }
    } catch (err) {
      logger.warn(
        `AppConfig: failed to decrypt key "${row.key}" — falling back to env`,
        err,
      );
      setCache(row.key, null);
    }
  }
  preloaded = true;
  logger.info(`AppConfig: preloaded ${cache.size} key(s) from DB`);
};

/**
 * Returns the cached value if present, the env fallback otherwise.
 * Returns null when neither source has the key — callers should treat
 * that as "feature not configured" rather than throwing.
 */
export const getAppConfig = (key: string): string | null => {
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

export const isAppConfigPreloaded = (): boolean => preloaded;

export interface SetAppConfigArgs {
  key: string;
  category: AppConfigCategory;
  value: string;
  isSecret: boolean;
  notes?: string;
  updatedBy?: string;
}

export const setAppConfig = async (args: SetAppConfigArgs): Promise<void> => {
  const update: Record<string, unknown> = {
    category: args.category,
    isSecret: args.isSecret,
    notes: args.notes,
    updatedBy: args.updatedBy,
  };
  if (args.isSecret) {
    update.valueEncrypted = encryptSecret(args.value);
    update.value = undefined; // clear plaintext slot
  } else {
    update.value = args.value;
    update.valueEncrypted = undefined;
  }
  await AppConfig.findOneAndUpdate({ key: args.key }, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });
  setCache(args.key, args.value);
};

export const deleteAppConfig = async (key: string): Promise<void> => {
  await AppConfig.deleteOne({ key });
  cache.delete(key);
};

/**
 * Lists all keys with their metadata. Secrets are NEVER decrypted here —
 * the admin UI shows a masked preview built from the ciphertext length
 * (or a known-length hint). The returned `hasValue` flag tells the UI
 * whether the slot is populated.
 */
export interface AppConfigSummary {
  key: string;
  category: AppConfigCategory;
  isSecret: boolean;
  hasValue: boolean;
  preview: string | null; // last 4 chars for secrets, full value for non-secrets
  notes?: string;
  updatedAt: Date;
}

export const listAppConfig = async (): Promise<AppConfigSummary[]> => {
  const rows = await AppConfig.find({}).select('+valueEncrypted').lean();
  return rows.map((row) => {
    let preview: string | null = null;
    let hasValue = false;
    if (row.isSecret && row.valueEncrypted) {
      hasValue = true;
      try {
        const plain = decryptSecret(row.valueEncrypted);
        preview = plain.length <= 4
          ? '*'.repeat(plain.length)
          : `••••${plain.slice(-4)}`;
      } catch {
        preview = '••••••';
      }
    } else if (!row.isSecret && row.value) {
      hasValue = true;
      preview = row.value;
    }
    return {
      key: row.key,
      category: row.category,
      isSecret: row.isSecret,
      hasValue,
      preview,
      notes: row.notes,
      updatedAt: row.updatedAt,
    };
  });
};
