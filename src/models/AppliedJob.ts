import mongoose, { Schema, Document, Model } from 'mongoose';

export type ApplicationStatus =
  | 'applied'
  | 'viewed'
  | 'interview'
  | 'offer'
  | 'rejected'
  | 'withdrawn';

export interface IAppliedJob extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  job: mongoose.Types.ObjectId;
  jobSnapshot: {
    title: string;
    company: string;
    location: string;
    url: string;
  };
  status: ApplicationStatus;
  matchScore?: number;
  appliedAt: Date;
  notes?: string;
  followUpDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const appliedJobSchema = new Schema<IAppliedJob>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    jobSnapshot: {
      title: { type: String, required: true },
      company: { type: String, required: true },
      location: { type: String, required: true },
      url: { type: String, required: true },
    },
    status: {
      type: String,
      enum: ['applied', 'viewed', 'interview', 'offer', 'rejected', 'withdrawn'],
      default: 'applied',
      index: true,
    },
    matchScore: { type: Number, min: 0, max: 100 },
    appliedAt: { type: Date, default: Date.now, index: true },
    notes: String,
    followUpDate: Date,
  },
  { timestamps: true },
);

appliedJobSchema.index({ user: 1, job: 1 }, { unique: true });
appliedJobSchema.index({ user: 1, status: 1, appliedAt: -1 });

export const AppliedJob: Model<IAppliedJob> = mongoose.model<IAppliedJob>(
  'AppliedJob',
  appliedJobSchema,
);
