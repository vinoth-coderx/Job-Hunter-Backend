import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ISalarySubmission extends Document {
  _id: mongoose.Types.ObjectId;
  // Optional — when set, lets us prevent dupes per (user, role, city).
  // Submissions remain anonymous in aggregations regardless.
  user?: mongoose.Types.ObjectId;

  role: string;
  city: string;
  industry?: string;
  company?: string;
  experienceYears: number;
  // Annual CTC in INR. We don't track currency separately for Phase 2 —
  // India launch only. International salaries arrive in Phase 4.
  salaryInr: number;
  submittedAt: Date;
}

const submissionSchema = new Schema<ISalarySubmission>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', sparse: true },
    role: { type: String, required: true, lowercase: true, trim: true, maxlength: 100, index: true },
    city: { type: String, required: true, lowercase: true, trim: true, maxlength: 100, index: true },
    industry: { type: String, lowercase: true, trim: true, maxlength: 100 },
    company: { type: String, trim: true, maxlength: 200 },
    experienceYears: { type: Number, required: true, min: 0, max: 60 },
    salaryInr: { type: Number, required: true, min: 0 },
    submittedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

submissionSchema.index({ role: 1, city: 1, submittedAt: -1 });
// Cap users to one submission per (role, city) combo so the same user
// can't skew the data by spamming entries.
submissionSchema.index(
  { user: 1, role: 1, city: 1 },
  {
    unique: true,
    partialFilterExpression: { user: { $exists: true } },
  },
);

export const SalarySubmission: Model<ISalarySubmission> =
  mongoose.model<ISalarySubmission>('SalarySubmission', submissionSchema);
