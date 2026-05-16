import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * ATS / resume analysis result. One row per (user, contentHash, jobId?)
 * — when `job` is set the analysis is tailored to that job's keywords;
 * when null it's a generic ATS pass.
 *
 * `contentHash` is sha256(resumeText + jobId ?? '') so re-running the
 * analyzer on an unchanged resume against the same target job is a
 * cache hit (cheap Mongo lookup) instead of a fresh AI call.
 *
 * Rows are kept indefinitely so the user can see their score trend
 * across resume revisions and the admin can audit AI judgements; that
 * means total volume scales with ((users) × (resume edits)), not
 * (requests). Acceptable.
 */

export interface IResumeAnalysisIssue {
  category: 'formatting' | 'keywords' | 'experience' | 'skills' | 'contact' | 'other';
  severity: 'high' | 'medium' | 'low';
  message: string;
}

export interface IResumeAnalysis extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  job?: mongoose.Types.ObjectId;
  contentHash: string;
  score: number;
  matchedSkills: string[];
  missingKeywords: string[];
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  formattingIssues: IResumeAnalysisIssue[];
  /** model tier used — for cost reporting */
  modelTier?: 'lite' | 'smart';
  usedAi: boolean;
  createdAt: Date;
}

const issueSchema = new Schema<IResumeAnalysisIssue>(
  {
    category: {
      type: String,
      enum: ['formatting', 'keywords', 'experience', 'skills', 'contact', 'other'],
      required: true,
    },
    severity: { type: String, enum: ['high', 'medium', 'low'], required: true },
    message: { type: String, required: true, maxlength: 400 },
  },
  { _id: false },
);

const resumeAnalysisSchema = new Schema<IResumeAnalysis>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: 'Job', index: true },
    contentHash: { type: String, required: true, index: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    matchedSkills: { type: [String], default: [] },
    missingKeywords: { type: [String], default: [] },
    strengths: { type: [String], default: [] },
    weaknesses: { type: [String], default: [] },
    suggestions: { type: [String], default: [] },
    formattingIssues: { type: [issueSchema], default: [] },
    modelTier: { type: String, enum: ['lite', 'smart'] },
    usedAi: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// Cache lookup: same user + same hash → return latest row.
resumeAnalysisSchema.index({ user: 1, contentHash: 1, createdAt: -1 });
// User dashboard: list a user's recent analyses.
resumeAnalysisSchema.index({ user: 1, createdAt: -1 });

export const ResumeAnalysis: Model<IResumeAnalysis> =
  mongoose.models.ResumeAnalysis ||
  mongoose.model<IResumeAnalysis>('ResumeAnalysis', resumeAnalysisSchema);
