import mongoose, { Document, Schema } from 'mongoose';

/**
 * Immutable ledger entry for every successful AI-credit top-up. The
 * unique `paymentId` index makes the verify path idempotent — both the
 * Razorpay /verify call and any future webhook can race to insert and
 * exactly one wins. The other side reads the existing row and reports
 * success without double-crediting the user's balance.
 *
 * The balance itself lives on the User document (aiTopUpCredits) — this
 * collection is the audit trail, not the source of truth for spend.
 */

export interface IAiCreditTopUp extends Document {
  user: mongoose.Types.ObjectId;
  packId: string;
  credits: number;
  amountInr: number;
  paymentId: string;
  orderId: string;
  mode: 'test' | 'live';
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IAiCreditTopUp>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    packId: { type: String, required: true, maxlength: 60 },
    credits: { type: Number, required: true, min: 1 },
    amountInr: { type: Number, required: true, min: 1 },
    paymentId: { type: String, required: true, unique: true },
    orderId: { type: String, required: true, index: true },
    mode: { type: String, enum: ['test', 'live'], required: true },
  },
  { timestamps: true },
);

export const AiCreditTopUp = mongoose.model<IAiCreditTopUp>(
  'AiCreditTopUp',
  schema,
);
