import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Admin-managed subscription plan catalog. Previously the catalog lived
 * as the `SUBSCRIPTION_PLANS` constant in `models/Subscription.ts`; we
 * keep that constant as the seed source and the source of truth shifts
 * to this collection at runtime.
 *
 * Tier is a free-form slug rather than the original enum so admins can
 * add new plans (e.g. "lifetime", "team") without a code change. The
 * four canonical tiers (free / weekly / monthly / yearly) are still
 * seeded on first boot so existing users and downstream code keep
 * working.
 */
export interface ISubscriptionPlan extends Document {
  _id: mongoose.Types.ObjectId;
  tier: string;
  name: string;
  priceInr: number;
  durationDays: number;
  features: string[];
  jobMatchLimit: number;
  apiCallLimit: number;
  prioritySupport: boolean;
  coinCost: number | null;
  /**
   * How many resume-template PDF downloads the seeker may produce in
   * one calendar month. `0` blocks the feature; `-1` is interpreted as
   * unlimited (used for paid tiers we don't want to throttle).
   */
  templateDownloadsPerMonth: number;
  isActive: boolean;
  sortOrder: number;
  badge: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const planSchema = new Schema<ISubscriptionPlan>(
  {
    tier: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    priceInr: { type: Number, required: true, min: 0 },
    durationDays: { type: Number, required: true, min: 1 },
    features: { type: [String], default: [] },
    jobMatchLimit: { type: Number, default: 0, min: 0 },
    apiCallLimit: { type: Number, default: 0, min: 0 },
    prioritySupport: { type: Boolean, default: false },
    coinCost: { type: Number, default: null, min: 0 },
    templateDownloadsPerMonth: { type: Number, default: 0, min: -1 },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 100 },
    badge: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

planSchema.index({ isActive: 1, sortOrder: 1 });

export const SubscriptionPlan: Model<ISubscriptionPlan> =
  mongoose.models.SubscriptionPlan ||
  mongoose.model<ISubscriptionPlan>('SubscriptionPlan', planSchema);
