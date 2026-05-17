import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Generic admin-managed runtime configuration. Replaces the per-feature
 * `.env` entries (Cloudinary, Razorpay, Stripe, SMTP, Firebase, job-board
 * APIs, cron toggle, …) so an operator can rotate credentials and flip
 * switches from the admin UI without a redeploy.
 *
 * The `key` is the canonical identifier and matches the old env var name
 * (e.g. `CLOUDINARY_API_SECRET`) so a quick mental grep stays accurate.
 * `category` groups related keys for the admin UI sidebar.
 *
 * Secrets (API keys, signing secrets, passwords) live in
 * [valueEncrypted] (AES-256-GCM via utils/aesCrypto). Non-secrets
 * (toggles, public IDs, public client IDs) live in [value] as plain text
 * so the admin UI can show them without a round-trip decrypt.
 */
export type AppConfigCategory =
  | 'job-board'
  | 'payment'
  | 'cloudinary'
  | 'email'
  | 'firebase'
  | 'cron'
  | 'ai'
  | 'misc';

export interface IAppConfig extends Document {
  key: string;
  category: AppConfigCategory;
  isSecret: boolean;
  // Per-runtime-mode values. The active mode is selected by the
  // `RUNTIME_MODE` AppConfig row ('test' or 'live'). At read time
  // `getAppConfig` returns the active-mode slot, falling back to the
  // legacy slot when only one side has been provisioned (e.g. for
  // mode-agnostic keys like RUNTIME_MODE itself).
  testValueEncrypted?: string;
  testValue?: string;
  liveValueEncrypted?: string;
  liveValue?: string;
  // Legacy single-mode slots — retained so pre-existing config rows keep
  // working and so mode-agnostic keys (RUNTIME_MODE, CRON_ENABLED,
  // RATE_LIMIT_*, etc.) have a place to live.
  valueEncrypted?: string;
  value?: string;
  notes?: string;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const appConfigSchema = new Schema<IAppConfig>(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
      unique: true,
      index: true,
    },
    category: {
      type: String,
      enum: ['job-board', 'payment', 'cloudinary', 'email', 'firebase', 'cron', 'ai', 'misc'],
      required: true,
      index: true,
    },
    isSecret: { type: Boolean, required: true, default: false },
    // select:false so a routine `find()` never leaks ciphertext to a
    // controller that forgot to project it explicitly.
    testValueEncrypted: { type: String, select: false },
    testValue: { type: String, maxlength: 4000 },
    liveValueEncrypted: { type: String, select: false },
    liveValue: { type: String, maxlength: 4000 },
    valueEncrypted: { type: String, select: false },
    value: { type: String, maxlength: 4000 },
    notes: { type: String, maxlength: 500 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

export const AppConfig: Model<IAppConfig> =
  mongoose.models.AppConfig ||
  mongoose.model<IAppConfig>('AppConfig', appConfigSchema);
