import mongoose, { Schema, Document, Model } from 'mongoose';
import { JobSource, JobType, RemoteType } from '../types';

export interface ISavedJobSnapshot {
  title: string;
  company: string;
  location: string;
  url: string;
  description?: string;
  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
  jobType?: JobType;
  remoteType?: RemoteType;
  skills?: string[];
  companyLogo?: string;
  postedAt?: Date;
  source: JobSource;
  externalId?: string;
}

export interface ISavedJob extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  job?: mongoose.Types.ObjectId;
  source: JobSource;
  externalId?: string;
  jobSnapshot: ISavedJobSnapshot;
  savedAt: Date;
}

const savedJobSnapshotSchema = new Schema<ISavedJobSnapshot>(
  {
    title: { type: String, required: true },
    company: { type: String, required: true },
    location: { type: String, required: true },
    url: { type: String, required: true },
    description: String,
    salaryMin: Number,
    salaryMax: Number,
    currency: String,
    jobType: String,
    remoteType: String,
    skills: { type: [String], default: undefined },
    companyLogo: String,
    postedAt: Date,
    source: { type: String, required: true },
    externalId: String,
  },
  { _id: false },
);

const savedJobSchema = new Schema<ISavedJob>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: 'Job', index: true, sparse: true },
    source: { type: String, required: true, index: true },
    externalId: { type: String, index: true, sparse: true },
    jobSnapshot: { type: savedJobSnapshotSchema, required: true },
    savedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

// Native jobs (job ObjectId present) — one save per (user, job).
savedJobSchema.index(
  { user: 1, job: 1 },
  { unique: true, partialFilterExpression: { job: { $exists: true } } },
);
// External jobs (externalId present) — one save per (user, source, externalId).
savedJobSchema.index(
  { user: 1, source: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $exists: true } } },
);
savedJobSchema.index({ user: 1, savedAt: -1 });

export const SavedJob: Model<ISavedJob> = mongoose.model<ISavedJob>('SavedJob', savedJobSchema);
