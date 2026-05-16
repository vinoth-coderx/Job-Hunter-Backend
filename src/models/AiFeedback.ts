import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Per-user thumbs feedback on AI outputs. Generic across features so
 * the same model works for chat replies, ATS scores, cover letters,
 * applicant rankings, etc.
 *
 * One row per (user, feature, refId) — the latest rating wins on
 * upsert. Persisting to Mongo (not Redis) so feedback survives chat
 * history TTLs and feeds into the admin AI analytics dashboard.
 *
 * `rating` semantics:
 *   -1 → thumbs-down
 *    0 → neutral / cleared (user un-rated)
 *    1 → thumbs-up
 *
 * `refId` is opaque — the producing feature decides what it means
 * (chat turn id, applicationId, jobId, etc.). Pair with `feature` so
 * lookups stay scoped.
 */
export type AiRating = -1 | 0 | 1;

export interface IAiFeedback extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  feature: string;
  refId: string;
  rating: AiRating;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const aiFeedbackSchema = new Schema<IAiFeedback>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    feature: { type: String, required: true, maxlength: 60, index: true },
    refId: { type: String, required: true, maxlength: 64 },
    rating: { type: Number, enum: [-1, 0, 1], required: true, index: true },
    note: { type: String, maxlength: 1000 },
  },
  { timestamps: true, versionKey: false },
);

// One opinion per (user, feature, refId). Upserts overwrite.
aiFeedbackSchema.index({ user: 1, feature: 1, refId: 1 }, { unique: true });
// Aggregation read pattern for admin analytics: per-feature thumbs split.
aiFeedbackSchema.index({ feature: 1, rating: 1, createdAt: -1 });

// 180-day TTL — feedback is mostly useful while the surfaces it rates
// are still in active rotation; older rows balloon the collection
// without changing the aggregate signal much.
aiFeedbackSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export const AiFeedback: Model<IAiFeedback> =
  mongoose.models.AiFeedback ||
  mongoose.model<IAiFeedback>('AiFeedback', aiFeedbackSchema);
