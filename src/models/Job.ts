import mongoose, { Schema, Document, Model } from 'mongoose';
import {
  JobSource,
  JobType,
  RemoteType,
  JobStatus,
  ScreeningQuestionType,
} from '../types';

export interface IScreeningQuestion {
  question: string;
  type: ScreeningQuestionType;
  options?: string[];
  isRequired: boolean;
}

export interface IJob extends Document {
  _id: mongoose.Types.ObjectId;

  // Native vs external. Existing scraped jobs keep isNative=false and
  // continue to work without any change.
  isNative: boolean;
  source: JobSource;

  // External-only (set when isNative=false)
  externalId?: string;

  // Native-only (set when isNative=true)
  hirerProfile?: mongoose.Types.ObjectId;
  postedBy?: mongoose.Types.ObjectId;

  title: string;
  company: string;
  companyLogoUrl?: string;
  department?: string;
  location: string;
  description: string;
  responsibilities?: string[];
  url: string;
  // Direct company-careers / employer site link extracted from the
  // listing when available. Preferred over `url` for external applies
  // so seekers land on the employer's own form instead of the
  // aggregator listing page.
  applyUrl?: string;

  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
  isSalaryVisible?: boolean;
  perks?: string[];

  jobType: JobType;
  remoteType: RemoteType;
  openingsCount?: number;
  experienceMinYears?: number;
  experienceMaxYears?: number;
  education?: string;

  skills: string[];
  niceToHaveSkills?: string[];

  applyType?: 'easy_apply' | 'custom_form';
  requiredDocuments?: string[];
  screeningQuestions?: IScreeningQuestion[];
  applicationDeadline?: Date;

  status: JobStatus;
  isBoosted?: boolean;
  boostExpiresAt?: Date;

  viewsCount: number;
  applicationsCount: number;
  shortlistedCount: number;

  scheduledPublishAt?: Date;
  publishedAt?: Date;
  expiresAt?: Date;
  closedAt?: Date;

  postedAt: Date;
  fetchedAt: Date;
  isActive: boolean;
  raw?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const screeningQuestionSchema = new Schema<IScreeningQuestion>(
  {
    question: { type: String, required: true, trim: true, maxlength: 500 },
    type: { type: String, enum: ['text', 'mcq', 'yes_no'], required: true },
    options: { type: [String], default: undefined },
    isRequired: { type: Boolean, default: false },
  },
  { _id: false },
);

const jobSchema = new Schema<IJob>(
  {
    isNative: { type: Boolean, default: false, index: true },
    source: {
      type: String,
      // Admin can register new generic sources at runtime
      // (models/JobSourceConfig), so we don't pin this to a fixed enum.
      // Slugs are still validated against the JobSourceConfig catalog
      // before any write reaches this collection.
      required: true,
      index: true,
    },
    externalId: { type: String, index: true, sparse: true },
    hirerProfile: { type: Schema.Types.ObjectId, ref: 'HirerProfile', index: true, sparse: true },
    postedBy: { type: Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },

    // Field-level `index: 'text'` is intentionally NOT used here because
    // MongoDB allows only ONE text index per collection. The compound
    // text index covering title/company/description/skills is declared
    // explicitly below via `jobSchema.index({...: 'text'})`.
    title: { type: String, required: true, trim: true, maxlength: 200 },
    company: { type: String, required: true, trim: true, maxlength: 200, index: true },
    companyLogoUrl: String,
    department: { type: String, trim: true, maxlength: 100 },
    location: { type: String, required: true, trim: true, maxlength: 200, index: true },
    description: { type: String, required: true, maxlength: 20000 },
    responsibilities: { type: [String], default: undefined },
    url: { type: String, required: true, maxlength: 2000 },
    applyUrl: { type: String, maxlength: 2000 },

    salaryMin: { type: Number, min: 0 },
    salaryMax: { type: Number, min: 0 },
    currency: { type: String, default: 'INR', maxlength: 8 },
    isSalaryVisible: { type: Boolean, default: true },
    perks: { type: [String], default: undefined },

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
    openingsCount: { type: Number, min: 1, default: 1 },
    experienceMinYears: { type: Number, min: 0, max: 60 },
    experienceMaxYears: { type: Number, min: 0, max: 60 },
    education: { type: String, maxlength: 200 },

    skills: { type: [String], default: [], index: true },
    niceToHaveSkills: { type: [String], default: undefined },

    applyType: { type: String, enum: ['easy_apply', 'custom_form'], default: 'easy_apply' },
    requiredDocuments: { type: [String], default: undefined },
    screeningQuestions: { type: [screeningQuestionSchema], default: undefined },
    applicationDeadline: Date,

    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'closed', 'expired'],
      default: 'active',
      index: true,
    },
    isBoosted: { type: Boolean, default: false, index: true },
    boostExpiresAt: Date,

    viewsCount: { type: Number, default: 0, min: 0 },
    applicationsCount: { type: Number, default: 0, min: 0 },
    shortlistedCount: { type: Number, default: 0, min: 0 },

    scheduledPublishAt: Date,
    publishedAt: Date,
    expiresAt: Date,
    closedAt: Date,

    postedAt: { type: Date, required: true, index: true },
    fetchedAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true, index: true },
    raw: Schema.Types.Mixed,
  },
  { timestamps: true },
);

// External jobs uniqueness — only enforced when both fields exist
// (partial filter), so multiple native jobs without externalId are allowed.
jobSchema.index(
  { externalId: 1, source: 1 },
  {
    unique: true,
    partialFilterExpression: { externalId: { $exists: true, $type: 'string' } },
  },
);
jobSchema.index({ title: 'text', company: 'text', description: 'text', skills: 'text' });
jobSchema.index({ postedAt: -1, isActive: 1 });
jobSchema.index({ skills: 1, location: 1, jobType: 1 });
jobSchema.index({ status: 1, isNative: 1, postedAt: -1 });
jobSchema.index({ hirerProfile: 1, status: 1, createdAt: -1 });

export const Job: Model<IJob> = mongoose.model<IJob>('Job', jobSchema);
