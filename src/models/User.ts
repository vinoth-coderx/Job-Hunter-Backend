import mongoose, { Schema, Document, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import { SubscriptionTier, SubscriptionStatus, JobType, RemoteType } from '../types';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  password?: string;
  googleId?: string;
  authProvider: 'local' | 'google';
  role: 'user' | 'admin';
  // Which side of the app the user is currently using.
  // Both modes share the same User document; the hirer side is gated
  // additionally on the existence of a HirerProfile.
  activeRole: 'seeker' | 'hirer';
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
    status: SubscriptionStatus;
    startDate?: Date;
    endDate?: Date;
    paymentId?: string;
    /// Set when the user activates the one-time auto-apply free trial.
    /// Trial is live for 7 days from this timestamp.
    trialActivatedAt?: Date;
    /// Latches true on first activation so the trial can't be re-claimed.
    trialUsed: boolean;
  };
  notificationPreferences: {
    push: boolean;
    email: boolean;
    whatsapp: boolean;
    jobAlerts: boolean;
    applicationUpdates: boolean;
    autoApplySummary: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
  };
  gamification: {
    streakCount: number;
    longestStreak: number;
    lastCheckinDate?: Date;
    earnedBadges: { badgeId: string; earnedAt: Date }[];
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
    activeRole: { type: String, enum: ['seeker', 'hirer'], default: 'seeker', index: true },
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
        enum: ['active', 'expired', 'cancelled', 'refunded'],
        default: 'active',
      },
      startDate: Date,
      endDate: Date,
      paymentId: String,
      // Auto-apply free trial (one per account, 7 days). When set, the
      // user gets `monthly`-tier auto-apply privileges until 7 days
      // after [trialActivatedAt]. We don't reset `trialUsed` once it
      // flips true, so the trial cannot be re-claimed by toggling.
      trialActivatedAt: Date,
      trialUsed: { type: Boolean, default: false },
    },
    notificationPreferences: {
      push: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
      // WhatsApp is opt-in per the spec.
      whatsapp: { type: Boolean, default: false },
      jobAlerts: { type: Boolean, default: true },
      applicationUpdates: { type: Boolean, default: true },
      autoApplySummary: { type: Boolean, default: true },
      // 'HH:mm' format. When both are set we suppress non-critical
      // pushes during the window — checked client-side and by the cron.
      quietHoursStart: { type: String, default: '22:00' },
      quietHoursEnd: { type: String, default: '08:00' },
    },
    gamification: {
      streakCount: { type: Number, default: 0, min: 0 },
      longestStreak: { type: Number, default: 0, min: 0 },
      lastCheckinDate: Date,
      earnedBadges: {
        type: [
          {
            _id: false,
            badgeId: { type: String, required: true, maxlength: 60 },
            earnedAt: { type: Date, default: Date.now },
          },
        ],
        default: [],
      },
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
