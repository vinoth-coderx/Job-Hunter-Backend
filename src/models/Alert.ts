import mongoose, { Schema, Document, Model } from 'mongoose';

/// A user-created job alert: same shape as a saved search, plus a
/// `lastNotifiedAt` cursor the cron uses to push only new matches.
export interface IAlert extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  label?: string;
  query: string;
  filters: string[];
  location?: string;
  sort?: string;
  active: boolean;
  /// Timestamp of the most recent matching job we've already pushed for
  /// this alert. The cron only sends jobs `postedAt > lastNotifiedAt`.
  lastNotifiedAt?: Date;
  /// Total notifications sent so the inbox can show a small count.
  notificationCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const alertSchema = new Schema<IAlert>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: String,
    query: { type: String, default: '' },
    filters: { type: [String], default: [] },
    location: String,
    sort: { type: String, default: 'mostRelevant' },
    active: { type: Boolean, default: true, index: true },
    lastNotifiedAt: Date,
    notificationCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

alertSchema.index({ user: 1, active: 1 });

export const Alert: Model<IAlert> = mongoose.model<IAlert>('Alert', alertSchema);
