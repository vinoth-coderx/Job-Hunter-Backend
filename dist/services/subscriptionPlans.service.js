"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPlan = exports.getActivePlans = exports.getAllPlans = exports.invalidatePlanCache = void 0;
const logger_1 = require("../utils/logger");
const SubscriptionPlan_1 = require("../models/SubscriptionPlan");
const Subscription_1 = require("../models/Subscription");
const CACHE_TTL_MS = 60_000;
let cache = null;
let seedingPromise = null;
const SEED_COIN_COST = {
    weekly: 500,
    monthly: 1500,
};
const SEED_TEMPLATE_DOWNLOADS = {
    free: 0,
    weekly: 5,
    monthly: 20,
    yearly: -1,
};
const SEED_SORT_ORDER = {
    free: 0,
    weekly: 10,
    monthly: 20,
    yearly: 30,
};
const SEED_BADGE = {
    yearly: 'Best value · Save 30%',
};
const toDTO = (doc) => ({
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
const seedIfEmpty = async () => {
    if (seedingPromise)
        return seedingPromise;
    seedingPromise = (async () => {
        const count = await SubscriptionPlan_1.SubscriptionPlan.estimatedDocumentCount();
        if (count > 0)
            return;
        const docs = Object.values(Subscription_1.SUBSCRIPTION_PLANS).map((p) => ({
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
        await SubscriptionPlan_1.SubscriptionPlan.insertMany(docs, { ordered: false }).catch((err) => {
            logger_1.logger.warn(`SubscriptionPlan seed: ${err.message ?? err}`);
        });
        logger_1.logger.info(`Seeded ${docs.length} subscription plans from constants`);
    })();
    try {
        await seedingPromise;
    }
    finally {
        seedingPromise = null;
    }
};
const invalidatePlanCache = () => {
    cache = null;
};
exports.invalidatePlanCache = invalidatePlanCache;
const readAllFromDb = async () => {
    await seedIfEmpty();
    const docs = await SubscriptionPlan_1.SubscriptionPlan.find().sort({ sortOrder: 1, priceInr: 1 }).lean();
    return docs.map(toDTO);
};
const getAllPlans = async () => {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_TTL_MS)
        return cache.plans;
    const plans = await readAllFromDb();
    cache = { at: now, plans };
    return plans;
};
exports.getAllPlans = getAllPlans;
const getActivePlans = async () => {
    const all = await (0, exports.getAllPlans)();
    return all.filter((p) => p.isActive);
};
exports.getActivePlans = getActivePlans;
const getPlan = async (tier) => {
    const all = await (0, exports.getAllPlans)();
    return all.find((p) => p.tier === tier) ?? null;
};
exports.getPlan = getPlan;
