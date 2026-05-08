import mongoose, { Schema, Document, Model } from 'mongoose';

export type CoverLetterTone = 'professional' | 'friendly' | 'technical';
export type RunDay =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export interface IAutoApplyPreferences {
  targetRoles: string[];
  locations: string[];
  isOpenToRemote: boolean;
  jobTypes: string[];
  minSalary?: number;
  experienceLevels: string[];
  // 'native' | 'external' | both. Phase 1 only natively-applies; external
  // sources are recorded as `external_manual` for tracking.
  sources: ('native' | 'external')[];
  companySizes: string[];
}

export interface IAutoApplyMatchingRules {
  // Floor for the matcher score; jobs below this never get applied to.
  minMatchPercentage: number;
  minSkillsMatchCount: number;
  mustIncludeKeywords: string[];
  excludeKeywords: string[];
  blacklistedCompanies: string[];
  reapplyCooldownDays: number; // 30 | 60 | 90
}

export interface IAutoApplySettings extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;

  isEnabled: boolean;
  isPaused: boolean;
  pauseUntil?: Date;
  pauseReason?: string;

  runTime: string; // 'HH:mm' in Asia/Kolkata
  runDays: RunDay[];
  dailyLimit: number; // capped by plan tier server-side

  preferences: IAutoApplyPreferences;
  matchingRules: IAutoApplyMatchingRules;

  // false = auto-send, true = surface matches and wait for explicit approve
  reviewMode: boolean;

  aiCoverLetter: {
    enabled: boolean;
    tone: CoverLetterTone;
    baseTemplate?: string;
  };

  totalAutoApplied: number;
  lastRunAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const preferencesSchema = new Schema<IAutoApplyPreferences>(
  {
    targetRoles: { type: [String], default: [] },
    locations: { type: [String], default: [] },
    isOpenToRemote: { type: Boolean, default: true },
    jobTypes: { type: [String], default: [] },
    minSalary: { type: Number, min: 0 },
    experienceLevels: { type: [String], default: [] },
    sources: {
      type: [String],
      enum: ['native', 'external'],
      default: ['native'],
    },
    companySizes: { type: [String], default: [] },
  },
  { _id: false },
);

const matchingRulesSchema = new Schema<IAutoApplyMatchingRules>(
  {
    minMatchPercentage: { type: Number, min: 50, max: 95, default: 70 },
    minSkillsMatchCount: { type: Number, min: 0, max: 10, default: 2 },
    mustIncludeKeywords: { type: [String], default: [] },
    excludeKeywords: { type: [String], default: [] },
    blacklistedCompanies: { type: [String], default: [] },
    reapplyCooldownDays: {
      type: Number,
      enum: [30, 60, 90],
      default: 60,
    },
  },
  { _id: false },
);

const autoApplySettingsSchema = new Schema<IAutoApplySettings>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    isEnabled: { type: Boolean, default: false, index: true },
    isPaused: { type: Boolean, default: false },
    pauseUntil: Date,
    pauseReason: { type: String, maxlength: 500 },

    runTime: { type: String, default: '09:00' },
    runDays: {
      type: [String],
      enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
      default: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    },
    dailyLimit: { type: Number, min: 1, max: 50, default: 10 },

    preferences: { type: preferencesSchema, default: () => ({}) },
    matchingRules: { type: matchingRulesSchema, default: () => ({}) },
    reviewMode: { type: Boolean, default: true },

    aiCoverLetter: {
      enabled: { type: Boolean, default: false },
      tone: {
        type: String,
        enum: ['professional', 'friendly', 'technical'],
        default: 'professional',
      },
      baseTemplate: { type: String, maxlength: 4000 },
    },

    totalAutoApplied: { type: Number, default: 0, min: 0 },
    lastRunAt: Date,
  },
  { timestamps: true },
);

export const AutoApplySettings: Model<IAutoApplySettings> = mongoose.model<IAutoApplySettings>(
  'AutoApplySettings',
  autoApplySettingsSchema,
);
