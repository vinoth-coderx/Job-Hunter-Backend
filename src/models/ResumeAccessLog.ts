import mongoose, { Schema, Document, Model } from 'mongoose';

// Every time a recruiter (or admin) views or downloads a seeker's
// resume the action is appended here. Seekers can see this log under
// "Resume privacy → who viewed my resume". Also rate-limits abusive
// scraping (downloads/day per hirer).
export type ResumeAccessAction = 'view' | 'download' | 'preview';

export interface IResumeAccessLog extends Document {
  _id: mongoose.Types.ObjectId;
  resumeOwner: mongoose.Types.ObjectId;
  accessor: mongoose.Types.ObjectId;
  accessorRole: 'hirer' | 'admin';
  company?: string;
  action: ResumeAccessAction;
  // The application context, when the access happened from an applicant
  // record. Null for cold-discovery views (resume database searches).
  application?: mongoose.Types.ObjectId;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

const resumeAccessLogSchema = new Schema<IResumeAccessLog>(
  {
    resumeOwner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accessor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accessorRole: { type: String, enum: ['hirer', 'admin'], required: true },
    company: String,
    action: { type: String, enum: ['view', 'download', 'preview'], required: true, index: true },
    application: { type: Schema.Types.ObjectId, ref: 'AppliedJob' },
    ip: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

resumeAccessLogSchema.index({ resumeOwner: 1, createdAt: -1 });
resumeAccessLogSchema.index({ accessor: 1, createdAt: -1 });

export const ResumeAccessLog: Model<IResumeAccessLog> = mongoose.model<IResumeAccessLog>(
  'ResumeAccessLog',
  resumeAccessLogSchema,
);
