import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Per-key configuration for AI providers. Replaces the single global
 * `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` entries in AppConfig with a
 * collection that supports multiple keys per provider, weighted routing,
 * per-key quotas, and per-feature allowlists.
 *
 * The ciphertext for `apiKey` is stored in [valueEncrypted] (AES-256-GCM
 * via utils/aesCrypto) and is `select: false` so a routine `find()`
 * never accidentally leaks it. The admin UI never receives the plaintext
 * — only a flag indicating whether a value is stored.
 */
export type AiProvider = 'gemini' | 'claude' | 'groq';
export type AiTier = 'free' | 'paid';

// Omit Document's `model` accessor — we want to use that name for the
// AI model identifier (gemini-2.5-flash etc) without colliding with the
// Mongoose method.
export interface IAiKey extends Omit<Document, 'model'> {
  _id: mongoose.Types.ObjectId;
  provider: AiProvider;
  label: string;
  apiKeyEncrypted: string;
  model: string;
  baseUrl?: string;
  priority: number;
  weight: number;
  tier: AiTier;
  dailyLimit: number;
  rpmLimit: number;
  maxTokens?: number;
  temperature?: number;
  allowedFeatures: string[];
  notes?: string;
  isActive: boolean;
  /** Live counter; reset by the AI quota service at IST midnight. */
  usageToday: number;
  lastUsedAt?: Date;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const aiKeySchema = new Schema<IAiKey>(
  {
    provider: {
      type: String,
      enum: ['gemini', 'claude', 'groq'],
      required: true,
      index: true,
    },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    // Ciphertext only — never select unless decrypting for routing. The
    // admin UI works purely off `hasValue` to avoid round-tripping.
    apiKeyEncrypted: { type: String, required: true, select: false },
    model: { type: String, required: true, trim: true, maxlength: 80 },
    baseUrl: { type: String, trim: true, maxlength: 200 },
    priority: { type: Number, default: 10, min: 0, max: 1000 },
    weight: { type: Number, default: 1, min: 0, max: 1000 },
    tier: { type: String, enum: ['free', 'paid'], default: 'free' },
    dailyLimit: { type: Number, default: 400, min: 0 },
    rpmLimit: { type: Number, default: 60, min: 0 },
    maxTokens: { type: Number, min: 0 },
    temperature: { type: Number, min: 0, max: 2 },
    allowedFeatures: { type: [String], default: [] },
    notes: { type: String, maxlength: 500 },
    isActive: { type: Boolean, default: true, index: true },
    usageToday: { type: Number, default: 0 },
    lastUsedAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, versionKey: false },
);

aiKeySchema.index({ provider: 1, priority: 1, isActive: 1 });

export const AiKey: Model<IAiKey> =
  mongoose.models.AiKey || mongoose.model<IAiKey>('AiKey', aiKeySchema);
