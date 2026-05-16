import mongoose, { Schema, Document, Model } from 'mongoose';

// User-filed reports for fraud / spam / harassment. Drives the admin
// "Reports" queue. The model is intentionally polymorphic across job /
// recruiter / message subjects so we can power a single triage UI.
export type ReportSubject = 'job' | 'recruiter' | 'message' | 'company' | 'review';
export type ReportReason =
  | 'fake_job'
  | 'fake_recruiter'
  | 'asks_payment'
  | 'mlm_scam'
  | 'misleading_salary'
  | 'discriminatory'
  | 'duplicate'
  | 'harassment'
  | 'spam'
  | 'phishing_link'
  | 'whatsapp_only_contact'
  | 'other';
export type ReportStatus = 'open' | 'under_review' | 'actioned' | 'dismissed';

export interface IReport extends Document {
  _id: mongoose.Types.ObjectId;
  reporter: mongoose.Types.ObjectId;
  subjectType: ReportSubject;
  subjectId: mongoose.Types.ObjectId;
  reason: ReportReason;
  description?: string;
  evidenceUrls: string[];
  status: ReportStatus;
  resolvedBy?: mongoose.Types.ObjectId;
  resolvedAt?: Date;
  resolutionNote?: string;
  action?:
    | 'job_unpublished'
    | 'recruiter_warned'
    | 'recruiter_suspended'
    | 'recruiter_banned'
    | 'company_flagged'
    | 'no_action';
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new Schema<IReport>(
  {
    reporter: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    subjectType: {
      type: String,
      enum: ['job', 'recruiter', 'message', 'company', 'review'],
      required: true,
      index: true,
    },
    subjectId: { type: Schema.Types.ObjectId, required: true, index: true },
    reason: {
      type: String,
      enum: [
        'fake_job',
        'fake_recruiter',
        'asks_payment',
        'mlm_scam',
        'misleading_salary',
        'discriminatory',
        'duplicate',
        'harassment',
        'spam',
        'phishing_link',
        'whatsapp_only_contact',
        'other',
      ],
      required: true,
      index: true,
    },
    description: { type: String, maxlength: 2000 },
    evidenceUrls: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['open', 'under_review', 'actioned', 'dismissed'],
      default: 'open',
      index: true,
    },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
    resolutionNote: String,
    action: {
      type: String,
      enum: [
        'job_unpublished',
        'recruiter_warned',
        'recruiter_suspended',
        'recruiter_banned',
        'company_flagged',
        'no_action',
      ],
    },
  },
  { timestamps: true },
);

reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ subjectType: 1, subjectId: 1, status: 1 });

export const Report: Model<IReport> = mongoose.model<IReport>('Report', reportSchema);
