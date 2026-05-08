import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IAutoApplyAppliedEntry {
  job: mongoose.Types.ObjectId;
  application?: mongoose.Types.ObjectId;
  companyName: string;
  jobTitle: string;
  matchScore: number;
  source: 'native' | 'external';
  appliedAt: Date;
  coverLetterUsed: boolean;
  status: string;
}

export type SkippedReason =
  | 'blacklisted'
  | 'below_match'
  | 'already_applied'
  | 'cooldown'
  | 'keyword_excluded'
  | 'missing_required_skills'
  | 'salary_below_threshold'
  | 'limit_reached';

export interface IAutoApplySkippedEntry {
  job: mongoose.Types.ObjectId;
  reason: SkippedReason;
  matchScore?: number;
}

export interface IAutoApplyLog extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  runDate: Date;

  jobsScanned: number;
  jobsMatched: number;
  jobsApplied: number;
  jobsSkipped: number;

  appliedJobs: IAutoApplyAppliedEntry[];
  skippedJobs: IAutoApplySkippedEntry[];

  // Set when the entry is in review-mode and is awaiting user approval.
  awaitingApproval: boolean;
  approvalCompletedAt?: Date;

  notificationSent: boolean;
  triggeredManually: boolean;

  createdAt: Date;
}

const appliedEntrySchema = new Schema<IAutoApplyAppliedEntry>(
  {
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    application: { type: Schema.Types.ObjectId, ref: 'AppliedJob' },
    companyName: { type: String, required: true },
    jobTitle: { type: String, required: true },
    matchScore: { type: Number, required: true, min: 0, max: 100 },
    source: { type: String, enum: ['native', 'external'], required: true },
    appliedAt: { type: Date, required: true },
    coverLetterUsed: { type: Boolean, default: false },
    status: { type: String, default: 'applied' },
  },
  { _id: false },
);

const skippedEntrySchema = new Schema<IAutoApplySkippedEntry>(
  {
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true },
    reason: {
      type: String,
      enum: [
        'blacklisted',
        'below_match',
        'already_applied',
        'cooldown',
        'keyword_excluded',
        'missing_required_skills',
        'salary_below_threshold',
        'limit_reached',
      ],
      required: true,
    },
    matchScore: { type: Number, min: 0, max: 100 },
  },
  { _id: false },
);

const autoApplyLogSchema = new Schema<IAutoApplyLog>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    runDate: { type: Date, required: true, index: true },

    jobsScanned: { type: Number, default: 0, min: 0 },
    jobsMatched: { type: Number, default: 0, min: 0 },
    jobsApplied: { type: Number, default: 0, min: 0 },
    jobsSkipped: { type: Number, default: 0, min: 0 },

    appliedJobs: { type: [appliedEntrySchema], default: [] },
    skippedJobs: { type: [skippedEntrySchema], default: [] },

    awaitingApproval: { type: Boolean, default: false, index: true },
    approvalCompletedAt: Date,

    notificationSent: { type: Boolean, default: false },
    triggeredManually: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

autoApplyLogSchema.index({ user: 1, runDate: -1 });
// 180-day retention — older runs auto-evict.
autoApplyLogSchema.index({ runDate: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export const AutoApplyLog: Model<IAutoApplyLog> = mongoose.model<IAutoApplyLog>(
  'AutoApplyLog',
  autoApplyLogSchema,
);
