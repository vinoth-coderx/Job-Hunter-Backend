import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { SubscriptionPlan } from '../models/SubscriptionPlan';
import {
  getAllPlans,
  invalidatePlanCache,
} from '../services/subscriptionPlans.service';

/**
 * Admin CRUD for subscription plans. The user-facing `/subscriptions/plans`
 * endpoint reads the same collection (filtered by isActive).
 *
 * Deactivation vs deletion: prefer the `isActive` toggle. A plan that has
 * been purchased should not be deleted — historical Subscription rows
 * reference its tier slug and downstream reports will break. The DELETE
 * endpoint refuses if any Subscription still references the tier.
 */

const TIER_SLUG = /^[a-z][a-z0-9_-]{1,38}[a-z0-9]$/;

const planBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  priceInr: z.number().min(0).max(1_000_000),
  durationDays: z.number().int().min(1).max(36500),
  features: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  jobMatchLimit: z.number().int().min(0).max(1_000_000).default(0),
  apiCallLimit: z.number().int().min(0).max(10_000_000).default(0),
  prioritySupport: z.boolean().default(false),
  coinCost: z.number().int().min(0).max(1_000_000).nullable().default(null),
  templateDownloadsPerMonth: z
    .number()
    .int()
    .min(-1)
    .max(100_000)
    .default(0),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  badge: z.string().trim().max(60).nullable().default(null),
});

export const createPlanSchema = z.object({
  body: planBodySchema.extend({
    tier: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(40)
      .regex(TIER_SLUG, 'tier must be lowercase letters/digits/_- only'),
  }),
});

// PATCH: same shape minus `tier` (immutable — Subscription rows reference it).
export const updatePlanSchema = z.object({
  body: planBodySchema.partial(),
  params: z.object({ tier: z.string().min(1) }),
});

export const togglePlanSchema = z.object({
  body: z.object({ isActive: z.boolean() }),
  params: z.object({ tier: z.string().min(1) }),
});

export const listAdminPlans = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    const plans = await getAllPlans();
    res.json({ plans });
  },
);

export const createPlan = asyncHandler(async (req: AuthRequest, res: Response) => {
  const body = req.body as z.infer<typeof createPlanSchema>['body'];
  const existing = await SubscriptionPlan.findOne({ tier: body.tier });
  if (existing) {
    throw ApiError.conflict(`Tier '${body.tier}' already exists`);
  }
  const doc = await SubscriptionPlan.create(body);
  invalidatePlanCache();
  res.status(201).json({ plan: doc.toJSON() });
});

export const updatePlan = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { tier } = req.params;
  const body = req.body as z.infer<typeof updatePlanSchema>['body'];
  const doc = await SubscriptionPlan.findOneAndUpdate(
    { tier },
    { $set: body },
    { new: true, runValidators: true },
  );
  if (!doc) throw ApiError.notFound(`Plan '${tier}' not found`);
  invalidatePlanCache();
  res.json({ plan: doc.toJSON() });
});

export const togglePlan = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { tier } = req.params;
  const { isActive } = req.body as { isActive: boolean };
  if (tier === 'free' && !isActive) {
    throw ApiError.badRequest('The free tier cannot be deactivated.');
  }
  const doc = await SubscriptionPlan.findOneAndUpdate(
    { tier },
    { $set: { isActive } },
    { new: true },
  );
  if (!doc) throw ApiError.notFound(`Plan '${tier}' not found`);
  invalidatePlanCache();
  res.json({ tier: doc.tier, isActive: doc.isActive });
});

export const deletePlan = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { tier } = req.params;
  if (tier === 'free') {
    throw ApiError.badRequest('The free tier cannot be deleted.');
  }
  // Importing here to avoid a circular import with subscription controller.
  const { Subscription } = await import('../models/Subscription');
  const usedBy = await Subscription.countDocuments({ tier });
  if (usedBy > 0) {
    throw ApiError.conflict(
      `Cannot delete '${tier}' — ${usedBy} subscription(s) reference it. Deactivate instead.`,
    );
  }
  const doc = await SubscriptionPlan.findOneAndDelete({ tier });
  if (!doc) throw ApiError.notFound(`Plan '${tier}' not found`);
  invalidatePlanCache();
  res.json({ tier });
});
