import mongoose, { Schema, Document, Model } from 'mongoose';

// Hirer verification submissions. A hirer can have many of these — one
// per channel (gst, domain, website, linkedin). Each row is reviewed
// independently and contributes to `HirerProfile.verification.levels`
// when approved. Admins act on these from the verification queue.
export type VerificationChannel = 'gst' | 'domain_email' | 'website' | 'linkedin' | 'identity';
export type VerificationStatus = 'pending' | 'auto_verified' | 'approved' | 'rejected' | 'expired';

export interface IVerification extends Document {
  _id: mongoose.Types.ObjectId;
  hirer: mongoose.Types.ObjectId;
  company: mongoose.Types.ObjectId;
  channel: VerificationChannel;
  status: VerificationStatus;
  payload: {
    gstNumber?: string;
    domainEmail?: string;
    domainEmailVerifiedAt?: Date;
    website?: string;
    websiteFileToken?: string;
    websiteVerifiedAt?: Date;
    linkedinUrl?: string;
    identityDocUrl?: string;
    identityDocType?: 'pan' | 'aadhaar' | 'passport' | 'driving_license';
  };
  // Free-text note the admin writes when approving/rejecting. Visible
  // to the hirer in their verification timeline so they know why a
  // submission was rejected and how to fix it.
  reviewNote?: string;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const verificationSchema = new Schema<IVerification>(
  {
    hirer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    company: { type: Schema.Types.ObjectId, ref: 'HirerProfile', required: true, index: true },
    channel: {
      type: String,
      enum: ['gst', 'domain_email', 'website', 'linkedin', 'identity'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'auto_verified', 'approved', 'rejected', 'expired'],
      default: 'pending',
      index: true,
    },
    payload: {
      gstNumber: { type: String, trim: true, maxlength: 32 },
      domainEmail: { type: String, trim: true, lowercase: true },
      domainEmailVerifiedAt: Date,
      website: { type: String, trim: true, maxlength: 500 },
      websiteFileToken: String,
      websiteVerifiedAt: Date,
      linkedinUrl: { type: String, maxlength: 500 },
      identityDocUrl: String,
      identityDocType: {
        type: String,
        enum: ['pan', 'aadhaar', 'passport', 'driving_license'],
      },
    },
    reviewNote: { type: String, maxlength: 2000 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    expiresAt: Date,
  },
  { timestamps: true },
);

verificationSchema.index({ status: 1, createdAt: -1 });
verificationSchema.index({ company: 1, channel: 1 });

export const Verification: Model<IVerification> = mongoose.model<IVerification>(
  'Verification',
  verificationSchema,
);
