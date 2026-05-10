import mongoose, { Schema, Document, Model } from 'mongoose';

export type CoinSource =
  | 'checkin'
  | 'apply'
  | 'resume_complete'
  | 'referral_install'
  | 'referral_share'
  | 'plan_redeem'
  | 'admin_adjust';

export interface ICoinLedger extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  // Positive = grant (earn). Negative = spend (redemption / admin clawback).
  amount: number;
  source: CoinSource;
  // Optional reference to the source document (AppliedJob id, referrer
  // user id, Subscription id, etc.) so the coins screen can deep-link.
  sourceRefId?: string;
  // Compound key per user that prevents double-grants. Examples:
  //   "checkin:2026-05-11" — at most one checkin grant per UTC day.
  //   "apply:<jobId>"      — at most one grant per applied job.
  //   "resume_complete:v1" — one-time bonus, never re-grants.
  idempotencyKey: string;
  // Snapshot of the post-grant balance for audit (so reconciling the
  // ledger doesn't require replaying the whole history).
  balanceAfter: number;
  meta?: Record<string, unknown>;
  createdAt: Date;
}

const coinLedgerSchema = new Schema<ICoinLedger>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true },
    source: {
      type: String,
      enum: [
        'checkin',
        'apply',
        'resume_complete',
        'referral_install',
        'referral_share',
        'plan_redeem',
        'admin_adjust',
      ],
      required: true,
      index: true,
    },
    sourceRefId: { type: String, maxlength: 200 },
    idempotencyKey: { type: String, required: true, maxlength: 200 },
    balanceAfter: { type: Number, required: true, min: 0 },
    meta: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One ledger row per (user, idempotencyKey). The unique constraint is
// the actual abuse guard — even if the grant helper races with itself,
// the second insert throws E11000 and is caught as "already granted".
coinLedgerSchema.index({ user: 1, idempotencyKey: 1 }, { unique: true });
coinLedgerSchema.index({ user: 1, createdAt: -1 });

export const CoinLedger: Model<ICoinLedger> = mongoose.model<ICoinLedger>(
  'CoinLedger',
  coinLedgerSchema,
);
