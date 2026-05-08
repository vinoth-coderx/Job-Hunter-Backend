import mongoose, { Schema, Document, Model } from 'mongoose';

export type ApplicationStatus =
  | 'applied'
  | 'viewed'
  | 'shortlisted'
  | 'interview'
  | 'offer'
  | 'hired'
  | 'rejected'
  | 'withdrawn';

export type ApplyType =
  | 'one_click'
  | 'custom_form'
  | 'auto_apply'
  | 'external_manual';

export interface IScreeningAnswer {
  question: string;
  answer: string;
}

export interface IStatusHistoryEntry {
  status: ApplicationStatus;
  changedAt: Date;
  changedBy?: mongoose.Types.ObjectId;
  note?: string;
}

export interface IAppliedJob extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  job: mongoose.Types.ObjectId;
  hirerProfile?: mongoose.Types.ObjectId;

  jobSnapshot: {
    title: string;
    company: string;
    location: string;
    url: string;
  };

  applyType: ApplyType;
  source: 'native' | 'indeed' | 'naukri' | 'linkedin' | 'other';
  resumeUrlSnapshot?: string;
  quickNote?: string;
  screeningAnswers?: IScreeningAnswer[];

  status: ApplicationStatus;
  statusHistory: IStatusHistoryEntry[];

  matchScore?: number;
  appliedAt: Date;
  notes?: string;
  hirerNotes?: string;
  rejectionReason?: string;
  followUpDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const screeningAnswerSchema = new Schema<IScreeningAnswer>(
  {
    question: { type: String, required: true, maxlength: 500 },
    answer: { type: String, required: true, maxlength: 2000 },
  },
  { _id: false },
);

const statusHistorySchema = new Schema<IStatusHistoryEntry>(
  {
    status: {
      type: String,
      enum: [
        'applied',
        'viewed',
        'shortlisted',
        'interview',
        'offer',
        'hired',
        'rejected',
        'withdrawn',
      ],
      required: true,
    },
    changedAt: { type: Date, required: true, default: Date.now },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, maxlength: 1000 },
  },
  { _id: false },
);

const appliedJobSchema = new Schema<IAppliedJob>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    hirerProfile: {
      type: Schema.Types.ObjectId,
      ref: 'HirerProfile',
      index: true,
      sparse: true,
    },
    jobSnapshot: {
      title: { type: String, required: true },
      company: { type: String, required: true },
      location: { type: String, required: true },
      url: { type: String, required: true },
    },
    applyType: {
      type: String,
      enum: ['one_click', 'custom_form', 'auto_apply', 'external_manual'],
      default: 'external_manual',
    },
    source: {
      type: String,
      enum: ['native', 'indeed', 'naukri', 'linkedin', 'other'],
      default: 'other',
    },
    resumeUrlSnapshot: { type: String, maxlength: 1000 },
    quickNote: { type: String, maxlength: 500 },
    screeningAnswers: { type: [screeningAnswerSchema], default: undefined },

    status: {
      type: String,
      enum: [
        'applied',
        'viewed',
        'shortlisted',
        'interview',
        'offer',
        'hired',
        'rejected',
        'withdrawn',
      ],
      default: 'applied',
      index: true,
    },
    statusHistory: { type: [statusHistorySchema], default: [] },

    matchScore: { type: Number, min: 0, max: 100 },
    appliedAt: { type: Date, default: Date.now, index: true },
    notes: { type: String, maxlength: 2000 },
    hirerNotes: { type: String, maxlength: 4000 },
    rejectionReason: { type: String, maxlength: 1000 },
    followUpDate: Date,
  },
  { timestamps: true },
);

appliedJobSchema.index({ user: 1, job: 1 }, { unique: true });
appliedJobSchema.index({ user: 1, status: 1, appliedAt: -1 });
appliedJobSchema.index({ hirerProfile: 1, status: 1, appliedAt: -1 });
appliedJobSchema.index({ job: 1, status: 1, appliedAt: -1 });

export const AppliedJob: Model<IAppliedJob> = mongoose.model<IAppliedJob>(
  'AppliedJob',
  appliedJobSchema,
);
