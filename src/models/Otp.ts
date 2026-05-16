import mongoose, { Schema, Document, Model } from 'mongoose';

// One-time codes issued for email + phone verification and 2FA fallback.
// Codes are stored as bcrypt hashes — we never persist plaintext. A
// per-document TTL index reaps expired rows so old codes can't pile up.
export type OtpChannel = 'email' | 'phone';
export type OtpPurpose =
  | 'email_verification'
  | 'phone_verification'
  | 'login_2fa'
  | 'password_reset'
  | 'sensitive_action';

export interface IOtp extends Document {
  _id: mongoose.Types.ObjectId;
  user?: mongoose.Types.ObjectId;
  identifier: string;
  channel: OtpChannel;
  purpose: OtpPurpose;
  codeHash: string;
  attempts: number;
  maxAttempts: number;
  consumedAt?: Date;
  expiresAt: Date;
  ip?: string;
  createdAt: Date;
}

const otpSchema = new Schema<IOtp>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    identifier: { type: String, required: true, lowercase: true, index: true },
    channel: { type: String, enum: ['email', 'phone'], required: true },
    purpose: {
      type: String,
      enum: ['email_verification', 'phone_verification', 'login_2fa', 'password_reset', 'sensitive_action'],
      required: true,
    },
    codeHash: { type: String, required: true, select: false },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    consumedAt: Date,
    expiresAt: { type: Date, required: true },
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

otpSchema.index({ identifier: 1, purpose: 1, createdAt: -1 });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Otp: Model<IOtp> = mongoose.model<IOtp>('Otp', otpSchema);
