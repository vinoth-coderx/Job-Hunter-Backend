import mongoose, { Schema, Document, Model } from 'mongoose';
import { CompanySize } from '../types';

export type TeamMemberRole = 'admin' | 'recruiter' | 'interviewer';

export interface ITeamMember {
  user: mongoose.Types.ObjectId;
  role: TeamMemberRole;
  addedAt: Date;
  isActive: boolean;
}

export interface IHirerProfile extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;

  companyName: string;
  companyLogoUrl?: string;
  industry?: string;
  companySize?: CompanySize;
  foundedYear?: number;
  website?: string;
  description?: string;
  cultureValues?: string;
  officePhotos: string[];

  headquarters: {
    city?: string;
    state?: string;
    country?: string;
    address?: string;
  };
  otherLocations: { city: string; state?: string }[];

  socialLinks: {
    linkedin?: string;
    twitter?: string;
    glassdoor?: string;
  };

  verification: {
    isVerified: boolean;
    gstNumber?: string;
    verifiedAt?: Date;
    verificationDocumentUrl?: string;
  };

  rating: {
    average: number;
    totalReviews: number;
  };

  followersCount: number;
  teamMembers: ITeamMember[];

  // Hirer subscription is independent of seeker subscription on the same User.
  hirerSubscription?: {
    plan: 'free' | 'starter' | 'growth' | 'enterprise';
    status: 'active' | 'trial' | 'expired' | 'cancelled';
    startDate?: Date;
    endDate?: Date;
    paymentId?: string;
  };

  createdAt: Date;
  updatedAt: Date;
}

const teamMemberSchema = new Schema<ITeamMember>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: {
      type: String,
      enum: ['admin', 'recruiter', 'interviewer'],
      required: true,
    },
    addedAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
  },
  { _id: false },
);

const hirerProfileSchema = new Schema<IHirerProfile>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    companyName: { type: String, required: true, trim: true, maxlength: 200, index: true },
    companyLogoUrl: String,
    industry: { type: String, trim: true, maxlength: 100, index: true },
    companySize: {
      type: String,
      enum: ['1-10', '11-50', '51-200', '201-500', '500-1000', '1000+'],
    },
    foundedYear: { type: Number, min: 1800, max: new Date().getFullYear() },
    website: { type: String, maxlength: 500 },
    description: { type: String, maxlength: 5000 },
    cultureValues: { type: String, maxlength: 5000 },
    officePhotos: { type: [String], default: [] },

    headquarters: {
      city: { type: String, trim: true, maxlength: 100 },
      state: { type: String, trim: true, maxlength: 100 },
      country: { type: String, trim: true, maxlength: 100, default: 'India' },
      address: { type: String, maxlength: 500 },
    },
    otherLocations: {
      type: [
        {
          _id: false,
          city: { type: String, required: true, trim: true, maxlength: 100 },
          state: { type: String, trim: true, maxlength: 100 },
        },
      ],
      default: [],
    },

    socialLinks: {
      linkedin: { type: String, maxlength: 500 },
      twitter: { type: String, maxlength: 500 },
      glassdoor: { type: String, maxlength: 500 },
    },

    verification: {
      isVerified: { type: Boolean, default: false, index: true },
      gstNumber: { type: String, trim: true, maxlength: 32 },
      verifiedAt: Date,
      verificationDocumentUrl: String,
    },

    rating: {
      average: { type: Number, default: 0, min: 0, max: 5 },
      totalReviews: { type: Number, default: 0, min: 0 },
    },

    followersCount: { type: Number, default: 0, min: 0 },
    teamMembers: { type: [teamMemberSchema], default: [] },

    hirerSubscription: {
      plan: {
        type: String,
        enum: ['free', 'starter', 'growth', 'enterprise'],
        default: 'free',
      },
      status: {
        type: String,
        enum: ['active', 'trial', 'expired', 'cancelled'],
        default: 'active',
      },
      startDate: Date,
      endDate: Date,
      paymentId: String,
    },
  },
  { timestamps: true },
);

hirerProfileSchema.index({ companyName: 'text', description: 'text' });

export const HirerProfile: Model<IHirerProfile> = mongoose.model<IHirerProfile>(
  'HirerProfile',
  hirerProfileSchema,
);
