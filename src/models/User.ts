import mongoose, { Schema, Document, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import { SubscriptionTier, JobType, RemoteType } from '../types';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  password?: string;
  googleId?: string;
  authProvider: 'local' | 'google';
  role: 'user' | 'admin';
  isEmailVerified: boolean;
  emailVerificationToken?: string;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  refreshTokens: string[];
  profile: {
    fullName: string;
    avatar?: string;
    avatarFile?: {
      filename: string;
      originalName: string;
      mimeType: string;
      size: number;
      uploadedAt: Date;
    };
    phone?: string;
    headline?: string;
    skills: string[];
    experienceYears: number;
    preferredRoles: string[];
    preferredLocations: string[];
    preferredJobTypes: JobType[];
    preferredRemote: RemoteType[];
    expectedSalaryMin?: number;
    resumeUrl?: string;
    resumeText?: string;
    resumeFile?: {
      filename: string;
      originalName: string;
      mimeType: string;
      size: number;
      uploadedAt: Date;
    };
  };
  subscription: {
    tier: SubscriptionTier;
    status: 'active' | 'expired' | 'cancelled';
    startDate?: Date;
    endDate?: Date;
    paymentId?: string;
  };
  lastLogin?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
    },
    password: {
      type: String,
      minlength: 8,
      select: false,
    },
    googleId: { type: String, sparse: true, unique: true },
    authProvider: { type: String, enum: ['local', 'google'], default: 'local' },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    isEmailVerified: { type: Boolean, default: false },
    emailVerificationToken: String,
    passwordResetToken: String,
    passwordResetExpires: Date,
    refreshTokens: { type: [String], default: [], select: false },
    profile: {
      fullName: { type: String, required: true, trim: true },
      avatar: String,
      avatarFile: {
        filename: String,
        originalName: String,
        mimeType: String,
        size: Number,
        uploadedAt: Date,
      },
      phone: String,
      headline: String,
      skills: { type: [String], default: [], index: true },
      experienceYears: { type: Number, default: 0, min: 0 },
      preferredRoles: { type: [String], default: [] },
      preferredLocations: { type: [String], default: [] },
      preferredJobTypes: {
        type: [String],
        enum: ['full-time', 'part-time', 'contract', 'internship', 'temporary', 'unknown'],
        default: [],
      },
      preferredRemote: {
        type: [String],
        enum: ['remote', 'hybrid', 'onsite', 'unknown'],
        default: [],
      },
      expectedSalaryMin: Number,
      resumeUrl: String,
      resumeText: String,
      resumeFile: {
        filename: String,
        originalName: String,
        mimeType: String,
        size: Number,
        uploadedAt: Date,
      },
    },
    subscription: {
      tier: {
        type: String,
        enum: ['free', 'weekly', 'monthly', 'yearly'],
        default: 'free',
      },
      status: {
        type: String,
        enum: ['active', 'expired', 'cancelled'],
        default: 'active',
      },
      startDate: Date,
      endDate: Date,
      paymentId: String,
    },
    lastLogin: Date,
  },
  { timestamps: true },
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidate: string): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(candidate, this.password);
};

userSchema.index({ 'profile.skills': 1 });
userSchema.index({ 'subscription.tier': 1, 'subscription.status': 1 });

export const User: Model<IUser> = mongoose.model<IUser>('User', userSchema);
