"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.deletePlan = exports.togglePlan = exports.updatePlan = exports.createPlan = exports.listAdminPlans = exports.togglePlanSchema = exports.updatePlanSchema = exports.createPlanSchema = void 0;
const zod_1 = require("zod");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const SubscriptionPlan_1 = require("../models/SubscriptionPlan");
const subscriptionPlans_service_1 = require("../services/subscriptionPlans.service");
const TIER_SLUG = /^[a-z][a-z0-9_-]{1,38}[a-z0-9]$/;
const planBodySchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(1).max(60),
    priceInr: zod_1.z.number().min(0).max(1_000_000),
    durationDays: zod_1.z.number().int().min(1).max(36500),
    features: zod_1.z.array(zod_1.z.string().trim().min(1).max(120)).max(20).default([]),
    jobMatchLimit: zod_1.z.number().int().min(0).max(1_000_000).default(0),
    apiCallLimit: zod_1.z.number().int().min(0).max(10_000_000).default(0),
    prioritySupport: zod_1.z.boolean().default(false),
    coinCost: zod_1.z.number().int().min(0).max(1_000_000).nullable().default(null),
    templateDownloadsPerMonth: zod_1.z
        .number()
        .int()
        .min(-1)
        .max(100_000)
        .default(0),
    isActive: zod_1.z.boolean().default(true),
    sortOrder: zod_1.z.number().int().min(0).max(10_000).default(100),
    badge: zod_1.z.string().trim().max(60).nullable().default(null),
});
exports.createPlanSchema = zod_1.z.object({
    body: planBodySchema.extend({
        tier: zod_1.z
            .string()
            .trim()
            .toLowerCase()
            .min(2)
            .max(40)
            .regex(TIER_SLUG, 'tier must be lowercase letters/digits/_- only'),
    }),
});
exports.updatePlanSchema = zod_1.z.object({
    body: planBodySchema.partial(),
    params: zod_1.z.object({ tier: zod_1.z.string().min(1) }),
});
exports.togglePlanSchema = zod_1.z.object({
    body: zod_1.z.object({ isActive: zod_1.z.boolean() }),
    params: zod_1.z.object({ tier: zod_1.z.string().min(1) }),
});
exports.listAdminPlans = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const plans = await (0, subscriptionPlans_service_1.getAllPlans)();
    res.json({ plans });
});
exports.createPlan = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const body = req.body;
    const existing = await SubscriptionPlan_1.SubscriptionPlan.findOne({ tier: body.tier });
    if (existing) {
        throw ApiError_1.ApiError.conflict(`Tier '${body.tier}' already exists`);
    }
    const doc = await SubscriptionPlan_1.SubscriptionPlan.create(body);
    (0, subscriptionPlans_service_1.invalidatePlanCache)();
    res.status(201).json({ plan: doc.toJSON() });
});
exports.updatePlan = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { tier } = req.params;
    const body = req.body;
    const doc = await SubscriptionPlan_1.SubscriptionPlan.findOneAndUpdate({ tier }, { $set: body }, { new: true, runValidators: true });
    if (!doc)
        throw ApiError_1.ApiError.notFound(`Plan '${tier}' not found`);
    (0, subscriptionPlans_service_1.invalidatePlanCache)();
    res.json({ plan: doc.toJSON() });
});
exports.togglePlan = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { tier } = req.params;
    const { isActive } = req.body;
    if (tier === 'free' && !isActive) {
        throw ApiError_1.ApiError.badRequest('The free tier cannot be deactivated.');
    }
    const doc = await SubscriptionPlan_1.SubscriptionPlan.findOneAndUpdate({ tier }, { $set: { isActive } }, { new: true });
    if (!doc)
        throw ApiError_1.ApiError.notFound(`Plan '${tier}' not found`);
    (0, subscriptionPlans_service_1.invalidatePlanCache)();
    res.json({ tier: doc.tier, isActive: doc.isActive });
});
exports.deletePlan = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { tier } = req.params;
    if (tier === 'free') {
        throw ApiError_1.ApiError.badRequest('The free tier cannot be deleted.');
    }
    const { Subscription } = await Promise.resolve().then(() => __importStar(require('../models/Subscription')));
    const usedBy = await Subscription.countDocuments({ tier });
    if (usedBy > 0) {
        throw ApiError_1.ApiError.conflict(`Cannot delete '${tier}' — ${usedBy} subscription(s) reference it. Deactivate instead.`);
    }
    const doc = await SubscriptionPlan_1.SubscriptionPlan.findOneAndDelete({ tier });
    if (!doc)
        throw ApiError_1.ApiError.notFound(`Plan '${tier}' not found`);
    (0, subscriptionPlans_service_1.invalidatePlanCache)();
    res.json({ tier });
});
