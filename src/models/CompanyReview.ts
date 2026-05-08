import mongoose, { Schema, Document, Model } from 'mongoose';

export type ReviewerRole = 'candidate' | 'employee' | 'ex_employee';

export interface ICompanyReviewRatings {
  overall: number;
  culture?: number;
  workLifeBalance?: number;
  growth?: number;
  pay?: number;
  management?: number;
}

export interface IInterviewExperience {
  difficulty?: 'easy' | 'medium' | 'hard';
  result?: 'got_offer' | 'rejected' | 'withdrew';
  description?: string;
}

export interface ICompanyReview extends Document {
  _id: mongoose.Types.ObjectId;
  hirerProfile: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  application?: mongoose.Types.ObjectId;

  isAnonymous: boolean;
  reviewerRole: ReviewerRole;

  ratings: ICompanyReviewRatings;
  title?: string;
  pros?: string;
  cons?: string;
  adviceToManagement?: string;

  interviewExperience?: IInterviewExperience;

  isApproved: boolean;
  helpfulCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const ratingsSchema = new Schema<ICompanyReviewRatings>(
  {
    overall: { type: Number, required: true, min: 1, max: 5 },
    culture: { type: Number, min: 1, max: 5 },
    workLifeBalance: { type: Number, min: 1, max: 5 },
    growth: { type: Number, min: 1, max: 5 },
    pay: { type: Number, min: 1, max: 5 },
    management: { type: Number, min: 1, max: 5 },
  },
  { _id: false },
);

const interviewExperienceSchema = new Schema<IInterviewExperience>(
  {
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
    result: { type: String, enum: ['got_offer', 'rejected', 'withdrew'] },
    description: { type: String, maxlength: 4000 },
  },
  { _id: false },
);

const reviewSchema = new Schema<ICompanyReview>(
  {
    hirerProfile: {
      type: Schema.Types.ObjectId,
      ref: 'HirerProfile',
      required: true,
      index: true,
    },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    application: { type: Schema.Types.ObjectId, ref: 'AppliedJob', sparse: true },

    isAnonymous: { type: Boolean, default: true },
    reviewerRole: {
      type: String,
      enum: ['candidate', 'employee', 'ex_employee'],
      default: 'candidate',
    },

    ratings: { type: ratingsSchema, required: true },
    title: { type: String, maxlength: 200 },
    pros: { type: String, maxlength: 4000 },
    cons: { type: String, maxlength: 4000 },
    adviceToManagement: { type: String, maxlength: 4000 },

    interviewExperience: { type: interviewExperienceSchema },

    isApproved: { type: Boolean, default: true, index: true },
    helpfulCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// One review per user per company — repeated submissions update the
// same document (handled at the controller level).
reviewSchema.index({ hirerProfile: 1, user: 1 }, { unique: true });
reviewSchema.index({ hirerProfile: 1, createdAt: -1 });

export const CompanyReview: Model<ICompanyReview> =
  mongoose.model<ICompanyReview>('CompanyReview', reviewSchema);
