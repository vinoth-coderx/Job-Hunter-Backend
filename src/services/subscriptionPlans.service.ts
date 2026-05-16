import { logger } from '../utils/logger';
import { SubscriptionPlan, ISubscriptionPlan } from '../models/SubscriptionPlan';
import { SUBSCRIPTION_PLANS } from '../models/Subscription';

/**
 * Read/write helper around the SubscriptionPlan collection.
 *
 * Plans are read on every checkout flow, so we keep a tiny in-process
 * cache (60s TTL). Admin mutations call `invalidateCache()` so the next
 * read picks up the change without waiting for the TTL.
 *
 * On first cold read of the collection we seed it from the legacy
 * `SUBSCRIPTION_PLANS` constant so existing deployments transition
 * without manual migration steps.
 */

export interface PlanDTO {
  tier: string;
  name: string;
  priceInr: number;
  durationDays: number;
  features: string[];
  jobMatchLimit: number;
  apiCallLimit: number;
  prioritySupport: boolean;
  coinCost: number | null;
  templateDownloadsPerMonth: number;
  isActive: boolean;
  sortOrder: number;
  badge: string | null;
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; plans: PlanDTO[] } | null = null;
let seedingPromise: Promise<void> | null = null;

// Mirror of the now-removed TIER_COIN_COST constant. Used only as seed data.
const SEED_COIN_COST: Record<string, number | null> = {
  weekly: 500,
  monthly: 1500,
};

// Default monthly template-download caps used on first seed. Admins can
// adjust these freely in the plan editor afterwards. `-1` = unlimited.
// Free tier is intentionally gated to 0 — the seeker should subscribe
// before they can download a polished resume. The preview is still
// available to everyone, but the PDF export is a paid feature.
const SEED_TEMPLATE_DOWNLOADS: Record<string, number> = {
  free: 0,
  weekly: 5,
  monthly: 20,
  yearly: -1,
};

// Display ordering used at seed time; admins can change later.
const SEED_SORT_ORDER: Record<string, number> = {
  free: 0,
  weekly: 10,
  monthly: 20,
  yearly: 30,
};

const SEED_BADGE: Record<string, string | null> = {
  yearly: 'Best value · Save 30%',
};

const toDTO = (doc: ISubscriptionPlan): PlanDTO => ({
  tier: doc.tier,
  name: doc.name,
  priceInr: doc.priceInr,
  durationDays: doc.durationDays,
  features: doc.features,
  jobMatchLimit: doc.jobMatchLimit,
  apiCallLimit: doc.apiCallLimit,
  prioritySupport: doc.prioritySupport,
  coinCost: doc.coinCost,
  templateDownloadsPerMonth: doc.templateDownloadsPerMonth ?? 0,
  isActive: doc.isActive,
  sortOrder: doc.sortOrder,
  badge: doc.badge,
});

const seedIfEmpty = async (): Promise<void> => {
  if (seedingPromise) return seedingPromise;
  seedingPromise = (async () => {
    const count = await SubscriptionPlan.estimatedDocumentCount();
    if (count > 0) return;
    const docs = Object.values(SUBSCRIPTION_PLANS).map((p) => ({
      tier: p.tier,
      name: p.name,
      priceInr: p.priceInr,
      durationDays: p.durationDays,
      features: p.features,
      jobMatchLimit: p.jobMatchLimit,
      apiCallLimit: p.apiCallLimit,
      prioritySupport: p.prioritySupport,
      coinCost: SEED_COIN_COST[p.tier] ?? null,
      templateDownloadsPerMonth: SEED_TEMPLATE_DOWNLOADS[p.tier] ?? 0,
      isActive: true,
      sortOrder: SEED_SORT_ORDER[p.tier] ?? 100,
      badge: SEED_BADGE[p.tier] ?? null,
    }));
    await SubscriptionPlan.insertMany(docs, { ordered: false }).catch((err) => {
      // Concurrent process may have seeded first — unique index on tier
      // will reject duplicates; that's fine.
      logger.warn(`SubscriptionPlan seed: ${err.message ?? err}`);
    });
    logger.info(`Seeded ${docs.length} subscription plans from constants`);
  })();
  try {
    await seedingPromise;
  } finally {
    seedingPromise = null;
  }
};

export const invalidatePlanCache = (): void => {
  cache = null;
};

const readAllFromDb = async (): Promise<PlanDTO[]> => {
  await seedIfEmpty();
  const docs = await SubscriptionPlan.find().sort({ sortOrder: 1, priceInr: 1 }).lean<ISubscriptionPlan[]>();
  return docs.map(toDTO);
};

/**
 * Returns all plans (active + inactive). Cached. Use this for admin views.
 */
export const getAllPlans = async (): Promise<PlanDTO[]> => {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.plans;
  const plans = await readAllFromDb();
  cache = { at: now, plans };
  return plans;
};

/**
 * Returns only `isActive=true` plans for user-facing pricing pages.
 */
export const getActivePlans = async (): Promise<PlanDTO[]> => {
  const all = await getAllPlans();
  return all.filter((p) => p.isActive);
};

/**
 * Single-plan lookup by tier slug. Inactive plans are STILL returned by
 * this helper because the activation paths (Razorpay webhook, coin
 * redemption) need to honor in-flight purchases against a plan that was
 * just deactivated. The /plans endpoint filters inactive ones for
 * display.
 */
export const getPlan = async (tier: string): Promise<PlanDTO | null> => {
  const all = await getAllPlans();
  return all.find((p) => p.tier === tier) ?? null;
};
