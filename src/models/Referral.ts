import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IReferral extends Document {
  _id: mongoose.Types.ObjectId;
  // Who shared the code.
  referrer: mongoose.Types.ObjectId;
  // Who signed up using the code (one claim per referee for life).
  referee: mongoose.Types.ObjectId;
  // Snapshot of the code at claim time. We persist it even though it's
  // derivable from referrer.referralCode, because a future code rotation
  // shouldn't rewrite history.
  codeUsed: string;
  // Granted amounts at claim. Stored alongside the row so reconciliation
  // doesn't need to replay the ledger to know what each referral was worth.
  refereeAmount: number;
  referrerAmount: number;
  createdAt: Date;
}

const referralSchema = new Schema<IReferral>(
  {
    referrer: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    referee: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    codeUsed: { type: String, required: true, maxlength: 32 },
    refereeAmount: { type: Number, required: true, min: 0 },
    referrerAmount: { type: Number, required: true, min: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One referee can only be claimed by one referrer, ever. Same row also
// blocks the referee from re-claiming a different code later.
referralSchema.index({ referee: 1 }, { unique: true });
// Lookups for "who has X referred?" stay cheap.
referralSchema.index({ referrer: 1, createdAt: -1 });

export const Referral: Model<IReferral> = mongoose.model<IReferral>(
  'Referral',
  referralSchema,
);
