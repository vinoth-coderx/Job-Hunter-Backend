import mongoose, { Schema, Document, Model } from 'mongoose';

// Per-job AI moderation record. Decoupled from `Job` so we can rerun
// moderation, keep a history, and let admin reverse decisions without
// rewriting the job document itself. `Job.moderation.status` is the
// denormalised pointer; this collection is the audit trail.
export type ModerationDecision = 'auto_approved' | 'queued' | 'auto_rejected';
export type ModerationFlag =
  | 'scam_keywords'
  | 'fake_salary'
  | 'suspicious_url'
  | 'whatsapp_only_contact'
  | 'telegram_only_contact'
  | 'asks_payment'
  | 'mlm_pattern'
  | 'discriminatory_language'
  | 'duplicate_content'
  | 'low_recruiter_trust'
  | 'missing_company_verification';

export type ModerationAppealStatus = 'pending' | 'accepted' | 'rejected';

/** Hirer-filed appeal against an auto/admin rejection. One per row. */
export interface IModerationAppeal {
  submittedBy: mongoose.Types.ObjectId;
  reason: string;
  submittedAt: Date;
  status: ModerationAppealStatus;
  adminNote?: string;
  resolvedBy?: mongoose.Types.ObjectId;
  resolvedAt?: Date;
}

export interface IJobModeration extends Document {
  _id: mongoose.Types.ObjectId;
  job: mongoose.Types.ObjectId;
  hirer: mongoose.Types.ObjectId;
  company?: mongoose.Types.ObjectId;
  riskScore: number;
  decision: ModerationDecision;
  flags: ModerationFlag[];
  contentHash: string;
  duplicateOf?: mongoose.Types.ObjectId;
  reasoning?: string;
  modelTier?: string;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  overrideDecision?: 'approved' | 'rejected';
  overrideNote?: string;
  appeal?: IModerationAppeal;
  createdAt: Date;
}

const jobModerationSchema = new Schema<IJobModeration>(
  {
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    hirer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    company: { type: Schema.Types.ObjectId, ref: 'HirerProfile' },
    riskScore: { type: Number, required: true, min: 0, max: 100, index: true },
    decision: {
      type: String,
      enum: ['auto_approved', 'queued', 'auto_rejected'],
      required: true,
      index: true,
    },
    flags: {
      type: [String],
      enum: [
        'scam_keywords',
        'fake_salary',
        'suspicious_url',
        'whatsapp_only_contact',
        'telegram_only_contact',
        'asks_payment',
        'mlm_pattern',
        'discriminatory_language',
        'duplicate_content',
        'low_recruiter_trust',
        'missing_company_verification',
      ],
      default: [],
    },
    contentHash: { type: String, required: true, index: true },
    duplicateOf: { type: Schema.Types.ObjectId, ref: 'Job' },
    reasoning: String,
    modelTier: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    overrideDecision: { type: String, enum: ['approved', 'rejected'] },
    overrideNote: String,
    appeal: {
      type: new Schema(
        {
          submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          reason: { type: String, required: true, maxlength: 2000 },
          submittedAt: { type: Date, default: Date.now },
          status: {
            type: String,
            enum: ['pending', 'accepted', 'rejected'],
            default: 'pending',
          },
          adminNote: { type: String, maxlength: 2000 },
          resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
          resolvedAt: Date,
        },
        { _id: false },
      ),
      required: false,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Pending appeals are the admin's primary work surface — index on both
// the embedded status field and createdAt for the queue listing.
jobModerationSchema.index({ 'appeal.status': 1, createdAt: -1 });

jobModerationSchema.index({ decision: 1, createdAt: -1 });
jobModerationSchema.index({ hirer: 1, createdAt: -1 });

export const JobModeration: Model<IJobModeration> = mongoose.model<IJobModeration>(
  'JobModeration',
  jobModerationSchema,
);
