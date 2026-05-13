import { JobSourceConfig, IJobSourceConfig } from '../models/JobSourceConfig';
import { KNOWN_SCRAPERS } from '../utils/scraperTracker';
import { logger } from '../utils/logger';

/**
 * On the very first boot (collection empty), populate `JobSourceConfig`
 * from the hardcoded `KNOWN_SCRAPERS` catalog so the admin UI has rows
 * to render and the scraper pipeline keeps working. Subsequent boots
 * are no-ops — admins own the catalog from here.
 *
 * If a new builtin scraper is added in code, this seeder will NOT
 * back-fill it on its own (collection isn't empty anymore). Use
 * `syncBuiltinSources()` for that — invoked at boot too so additions
 * appear automatically without resetting admin toggles.
 */
export const seedJobSourceConfigs = async (): Promise<void> => {
  try {
    const existing = await JobSourceConfig.estimatedDocumentCount();
    if (existing > 0) {
      await syncBuiltinSources();
      return;
    }
    await JobSourceConfig.insertMany(
      KNOWN_SCRAPERS.map((def) => ({
        source: def.source,
        label: def.label,
        category: def.category,
        pricing: def.pricing,
        type: 'builtin' as const,
        enabled: true,
        keyConfigKeys: def.keyConfigKeys,
        queries: [],
        locations: [],
        notes: def.notes,
      })),
    );
    logger.info(
      `JobSourceConfig: seeded ${KNOWN_SCRAPERS.length} builtin sources`,
    );
  } catch (err) {
    logger.warn(`JobSourceConfig seed failed: ${(err as Error).message}`);
  }
};

/**
 * Inserts any builtin source from KNOWN_SCRAPERS that isn't yet in the
 * DB. Never touches existing rows (admin's `enabled` flag wins).
 */
export const syncBuiltinSources = async (): Promise<void> => {
  const existing = await JobSourceConfig.find({}, { source: 1 }).lean();
  const have = new Set(existing.map((d) => d.source));
  const missing = KNOWN_SCRAPERS.filter((d) => !have.has(d.source));
  if (missing.length === 0) return;
  await JobSourceConfig.insertMany(
    missing.map((def) => ({
      source: def.source,
      label: def.label,
      category: def.category,
      pricing: def.pricing,
      type: 'builtin' as const,
      enabled: true,
      keyConfigKeys: def.keyConfigKeys,
      queries: [],
      locations: [],
      notes: def.notes,
    })),
  );
  logger.info(
    `JobSourceConfig: synced ${missing.length} new builtin source(s)`,
  );
};

let cache: IJobSourceConfig[] = [];
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30 * 1000;

/**
 * Lightly cached read used by the scraper pipeline to know which
 * sources are currently enabled. 30-second TTL keeps the hot path
 * Mongo-free while still picking up admin toggles within a reasonable
 * window. Call `invalidateJobSourceCache()` after any admin write to
 * make the change immediate.
 */
export const getJobSourceConfigs = async (
  forceRefresh = false,
): Promise<IJobSourceConfig[]> => {
  const now = Date.now();
  if (!forceRefresh && cache.length > 0 && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cache;
  }
  cache = await JobSourceConfig.find({}).sort({ type: 1, source: 1 });
  cacheLoadedAt = now;
  return cache;
};

export const invalidateJobSourceCache = (): void => {
  cache = [];
  cacheLoadedAt = 0;
};

export const getJobSourceConfig = async (
  source: string,
): Promise<IJobSourceConfig | null> => {
  const all = await getJobSourceConfigs();
  return all.find((d) => d.source === source) ?? null;
};
