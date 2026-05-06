import mongoose, { Schema, Document, Model } from 'mongoose';
import { JobSource, JobType, RemoteType } from '../types';

export interface IJob extends Document {
  _id: mongoose.Types.ObjectId;
  externalId: string;
  source: JobSource;
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
  jobType: JobType;
  remoteType: RemoteType;
  skills: string[];
  postedAt: Date;
  fetchedAt: Date;
  isActive: boolean;
  raw?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<IJob>(
  {
    externalId: { type: String, required: true, index: true },
    source: {
      type: String,
      enum: ['adzuna', 'serpapi', 'rapidapi', 'puppeteer', 'playwright'],
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, index: 'text' },
    company: { type: String, required: true, trim: true, index: true },
    location: { type: String, required: true, trim: true, index: true },
    description: { type: String, required: true, index: 'text' },
    url: { type: String, required: true },
    salaryMin: Number,
    salaryMax: Number,
    currency: String,
    jobType: {
      type: String,
      enum: ['full-time', 'part-time', 'contract', 'internship', 'temporary', 'unknown'],
      default: 'unknown',
    },
    remoteType: {
      type: String,
      enum: ['remote', 'hybrid', 'onsite', 'unknown'],
      default: 'unknown',
    },
    skills: { type: [String], default: [], index: true },
    postedAt: { type: Date, required: true, index: true },
    fetchedAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true, index: true },
    raw: Schema.Types.Mixed,
  },
  { timestamps: true },
);

jobSchema.index({ externalId: 1, source: 1 }, { unique: true });
jobSchema.index({ title: 'text', company: 'text', description: 'text', skills: 'text' });
jobSchema.index({ postedAt: -1, isActive: 1 });
jobSchema.index({ skills: 1, location: 1, jobType: 1 });

export const Job: Model<IJob> = mongoose.model<IJob>('Job', jobSchema);
