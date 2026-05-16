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
  // Cloudinary public_id for the current logo — kept so we can delete
  // the previous asset on re-upload without parsing URLs.
  companyLogoPublicId?: string;
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
    // Per-channel verification status. Each flag flips true when the
    // corresponding Verification row is approved by admin (or, for
    // domain_email, when the OTP is consumed). `isVerified` is the OR
    // of all of these.
    levels: {
      gst: boolean;
      domainEmail: boolean;
      website: boolean;
      linkedin: boolean;
      identity: boolean;
    };
    gstNumber?: string;
    officialDomainEmail?: string;
    linkedinPageUrl?: string;
    verifiedAt?: Date;
    verificationDocumentUrl?: string;
  };

  // Anti-fraud state. `approvalStatus` gates whether this hirer can
  // publish jobs at all — new accounts start in `pending_review` and
  // are flipped to `approved` after admin signs off. `trustScore` is
  // computed nightly from `services/trust/trustScore.service.ts` and
  // influences moderation auto-approve thresholds and posting limits.
  approvalStatus: 'pending_review' | 'approved' | 'suspended' | 'banned';
  approvalNote?: string;
  approvedAt?: Date;
  approvedBy?: mongoose.Types.ObjectId;
  trustScore: number;
  dailyPostLimit: number;
  totalJobsPosted: number;
  totalJobsFlagged: number;
  totalReportsAgainst: number;
  riskFlags: string[];

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
    companyLogoPublicId: String,
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
      levels: {
        gst: { type: Boolean, default: false },
        domainEmail: { type: Boolean, default: false },
        website: { type: Boolean, default: false },
        linkedin: { type: Boolean, default: false },
        identity: { type: Boolean, default: false },
      },
      gstNumber: { type: String, trim: true, maxlength: 32 },
      officialDomainEmail: { type: String, trim: true, lowercase: true, maxlength: 200 },
      linkedinPageUrl: { type: String, maxlength: 500 },
      verifiedAt: Date,
      verificationDocumentUrl: String,
    },

    approvalStatus: {
      type: String,
      enum: ['pending_review', 'approved', 'suspended', 'banned'],
      default: 'pending_review',
      index: true,
    },
    approvalNote: { type: String, maxlength: 2000 },
    approvedAt: Date,
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    trustScore: { type: Number, default: 30, min: 0, max: 100, index: true },
    dailyPostLimit: { type: Number, default: 3, min: 0 },
    totalJobsPosted: { type: Number, default: 0 },
    totalJobsFlagged: { type: Number, default: 0 },
    totalReportsAgainst: { type: Number, default: 0 },
    riskFlags: { type: [String], default: [] },

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
