import mongoose, { Schema, Document, Model } from 'mongoose';
import { SubscriptionTier, SubscriptionStatus } from '../types';

export interface ISubscriptionPlan {
  tier: SubscriptionTier;
  name: string;
  priceInr: number;
  durationDays: number;
  features: string[];
  jobMatchLimit: number;
  apiCallLimit: number;
  prioritySupport: boolean;
}

export const SUBSCRIPTION_PLANS: Record<SubscriptionTier, ISubscriptionPlan> = {
  free: {
    tier: 'free',
    name: 'Free',
    priceInr: 0,
    durationDays: 36500,
    features: ['Basic job search', '5 matched jobs/day', 'Email support'],
    jobMatchLimit: 5,
    apiCallLimit: 50,
    prioritySupport: false,
  },
  weekly: {
    tier: 'weekly',
    name: 'Weekly',
    priceInr: 99,
    durationDays: 7,
    features: ['Unlimited matches', 'AI profile match', 'Priority refresh'],
    jobMatchLimit: 100,
    apiCallLimit: 1000,
    prioritySupport: false,
  },
  monthly: {
    tier: 'monthly',
    name: 'Monthly',
    priceInr: 299,
    durationDays: 30,
    features: ['Everything in Weekly', 'Advanced filters', 'Resume insights'],
    jobMatchLimit: 500,
    apiCallLimit: 10000,
    prioritySupport: true,
  },
  yearly: {
    tier: 'yearly',
    name: 'Yearly',
    priceInr: 2499,
    durationDays: 365,
    features: ['Everything in Monthly', 'Save 30%', 'Dedicated support'],
    jobMatchLimit: 10000,
    apiCallLimit: 100000,
    prioritySupport: true,
  },
};

export interface ISubscription extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  startDate: Date;
  endDate: Date;
  amountPaid: number;
  currency: string;
  paymentMethod?: 'razorpay' | 'stripe' | 'manual' | 'coins';
  paymentId?: string;
  orderId?: string;
  invoiceUrl?: string;
  autoRenew: boolean;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tier: {
      // Admin-managed via SubscriptionPlan; enum removed to allow custom slugs.
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'expired', 'cancelled', 'refunded'],
      default: 'active',
      index: true,
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true, index: true },
    amountPaid: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    paymentMethod: { type: String, enum: ['razorpay', 'stripe', 'manual', 'coins'] },
    paymentId: String,
    orderId: String,
    invoiceUrl: String,
    autoRenew: { type: Boolean, default: false },
    cancelledAt: Date,
  },
  { timestamps: true },
);

subscriptionSchema.index({ user: 1, status: 1 });
subscriptionSchema.index({ endDate: 1, status: 1 });
// Hard guarantee against duplicate activation under a race between the
// client `/verify` call and the Razorpay webhook. `sparse` is required so
// free-tier subs (no paymentId) don't collide on null.
subscriptionSchema.index({ paymentId: 1 }, { unique: true, sparse: true });

export const Subscription: Model<ISubscription> = mongoose.model<ISubscription>(
  'Subscription',
  subscriptionSchema,
);
