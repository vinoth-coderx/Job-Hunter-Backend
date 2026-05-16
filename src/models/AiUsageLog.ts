import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Per-call AI usage record. Fire-and-forget written from the provider
 * layer so every `generate()` and `generateJson()` invocation lands one
 * row regardless of which service called it. Powers:
 *   - admin AI analytics dashboard (per-feature breakdown, cost trend)
 *   - per-user "AI activity" view in the future
 *   - regression alerting if a feature suddenly burns 10× more tokens
 *
 * `cacheHit: true` rows have zero token counts and are written when a
 * service serves a cached response without calling the provider — so the
 * dashboard can show the cache-savings ratio.
 *
 * The `feature` string is free-form (not enum) to keep this open for new
 * AI services without a schema migration; the admin UI groups by it.
 */
export type AiUsageProvider = 'gemini' | 'claude' | 'groq';
export type AiUsageTier = 'lite' | 'smart';

export interface IAiUsageLog extends Document {
  _id: mongoose.Types.ObjectId;
  user?: mongoose.Types.ObjectId;
  feature: string;
  provider: AiUsageProvider;
  tier: AiUsageTier;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
  cacheHit: boolean;
  createdAt: Date;
}

const aiUsageLogSchema = new Schema<IAiUsageLog>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    feature: { type: String, required: true, index: true, maxlength: 60 },
    provider: {
      type: String,
      enum: ['gemini', 'claude', 'groq'],
      required: true,
      index: true,
    },
    tier: { type: String, enum: ['lite', 'smart'], required: true },
    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
    totalTokens: { type: Number, default: 0, min: 0 },
    estimatedCostUsd: { type: Number, default: 0, min: 0 },
    latencyMs: { type: Number, default: 0, min: 0 },
    success: { type: Boolean, default: true, index: true },
    errorCode: { type: String, maxlength: 60 },
    cacheHit: { type: Boolean, default: false, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

aiUsageLogSchema.index({ createdAt: -1 });
aiUsageLogSchema.index({ feature: 1, createdAt: -1 });
aiUsageLogSchema.index({ provider: 1, createdAt: -1 });
aiUsageLogSchema.index({ user: 1, createdAt: -1 });

// 90-day TTL — analytics rarely needs raw rows older than a quarter, and
// keeping it longer balloons the collection. Aggregated daily summaries
// (future work) can be persisted separately if longer history is needed.
aiUsageLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const AiUsageLog: Model<IAiUsageLog> =
  mongoose.models.AiUsageLog ||
  mongoose.model<IAiUsageLog>('AiUsageLog', aiUsageLogSchema);
