import mongoose, { Schema, Document, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import { SubscriptionTier, SubscriptionStatus, JobType, RemoteType } from '../types';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  password?: string;
  googleId?: string;
  // Firebase Auth UID — populated when the user signed in via the
  // Firebase Auth hybrid flow. Same User document; multiple providers
  // can coexist on one record (e.g. local password + later Firebase).
  firebaseUid?: string;
  authProvider: 'local' | 'google' | 'firebase';
  // Which side of the app the user is currently using.
  // Both modes share the same User document; the hirer side is gated
  // additionally on the existence of a HirerProfile.
  activeRole: 'seeker' | 'hirer';
  // Orthogonal to activeRole — a hirer or seeker can also be an admin.
  // Grants access to /api/v1/admin/*; does not replace activeRole.
  isAdmin: boolean;
  // Ban flag toggled from /admin/users/:id/ban. Banned users keep
  // their document for history; the auth middleware rejects them.
  isBanned: boolean;
  bannedAt?: Date;
  banReason?: string;
  isEmailVerified: boolean;
  emailVerificationToken?: string;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  refreshTokens: string[];
  // Human-friendly share code (e.g. "RA8F2Q") generated lazily on first
  // /seeker/referrals/code call. Indexed unique-sparse so existing rows
  // without a code are valid and only generated codes have to be unique.
  referralCode?: string;
  profile: {
    fullName: string;
    avatar?: string;
    avatarFile?: {
      // Cloudinary identifiers — used to delete the old asset when a
      // new one is uploaded.
      publicId?: string;
      url?: string;
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
      publicId?: string;
      url?: string;
      filename: string;
      originalName: string;
      mimeType: string;
      size: number;
      uploadedAt: Date;
    };
    // Structured resume profile — kept separate from `skills`,
    // `experienceYears`, `preferredLocations` etc. above (those remain
    // the canonical fields used by the matching engine and onboarding
    // answers). This subdoc holds the long-form Naukri-style sections
    // shown on the "My Profile" screen, persisted so a reinstall or
    // device switch doesn't blank them out.
    resumeProfile?: {
      profileSummary?: string;
      employments?: {
        designation: string;
        company: string;
        period: string;
        current: boolean;
      }[];
      educations?: {
        degree: string;
        institute: string;
        period: string;
        type: string;
        projects: string[];
      }[];
      itSkills?: {
        skill: string;
        version: string;
        lastUsed: string;
        experience: string;
      }[];
      projects?: {
        title: string;
        company: string;
        type: string;
        period: string;
        description: string;
      }[];
      languages?: {
        language: string;
        proficiency: string;
        read: boolean;
        write: boolean;
        speak: boolean;
      }[];
      accomplishments?: {
        type: string;
        label: string;
        value: string;
      }[];
      careerProfile?: {
        currentIndustry: string;
        department: string;
        roleCategory: string;
        jobRole: string;
        desiredJobType: string;
        desiredEmploymentType: string;
        preferredShift: string;
        preferredLocation: string;
        expectedSalary: string;
      };
      personalDetails?: {
        gender: string;
        maritalStatus: string;
        dob: string;
        category: string;
        workPermit: string;
        address: string;
      };
      diversityNote?: string;
      updatedAt?: Date;
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
    // Soft currency wallet. Earned via applies / resume completion /
    // daily check-ins / referrals; spent to unlock subscription tiers.
    // Authoritative balance — never trust a client-supplied delta;
    // all mutations go through server-side ledger entries.
    coins: number;
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
    firebaseUid: { type: String, sparse: true, unique: true },
    authProvider: { type: String, enum: ['local', 'google', 'firebase'], default: 'local' },
    activeRole: { type: String, enum: ['seeker', 'hirer'], default: 'seeker', index: true },
    isAdmin: { type: Boolean, default: false, index: true },
    isBanned: { type: Boolean, default: false, index: true },
    bannedAt: Date,
    banReason: String,
    isEmailVerified: { type: Boolean, default: false },
    emailVerificationToken: String,
    passwordResetToken: String,
    passwordResetExpires: Date,
    refreshTokens: { type: [String], default: [], select: false },
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
      uppercase: true,
      trim: true,
      maxlength: 12,
    },
    profile: {
      fullName: { type: String, required: true, trim: true },
      avatar: String,
      avatarFile: {
        publicId: String,
        url: String,
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
        publicId: String,
        url: String,
        filename: String,
        originalName: String,
        mimeType: String,
        size: Number,
        uploadedAt: Date,
      },
      resumeProfile: {
        profileSummary: String,
        employments: {
          type: [
            {
              _id: false,
              designation: { type: String, default: '' },
              company: { type: String, default: '' },
              period: { type: String, default: '' },
              current: { type: Boolean, default: false },
            },
          ],
          default: [],
        },
        educations: {
          type: [
            {
              _id: false,
              degree: { type: String, default: '' },
              institute: { type: String, default: '' },
              period: { type: String, default: '' },
              type: { type: String, default: 'Full Time' },
              projects: { type: [String], default: [] },
            },
          ],
          default: [],
        },
        itSkills: {
          type: [
            {
              _id: false,
              skill: { type: String, default: '' },
              version: { type: String, default: '-' },
              lastUsed: { type: String, default: '' },
              experience: { type: String, default: '' },
            },
          ],
          default: [],
        },
        projects: {
          type: [
            {
              _id: false,
              title: { type: String, default: '' },
              company: { type: String, default: '' },
              type: { type: String, default: 'Full Time' },
              period: { type: String, default: '' },
              description: { type: String, default: '' },
            },
          ],
          default: [],
        },
        languages: {
          type: [
            {
              _id: false,
              language: { type: String, default: '' },
              proficiency: { type: String, default: 'Intermediate' },
              read: { type: Boolean, default: true },
              write: { type: Boolean, default: true },
              speak: { type: Boolean, default: true },
            },
          ],
          default: [],
        },
        accomplishments: {
          type: [
            {
              _id: false,
              type: { type: String, default: '' },
              label: { type: String, default: '' },
              value: { type: String, default: '' },
            },
          ],
          default: [],
        },
        careerProfile: {
          currentIndustry: { type: String, default: '' },
          department: { type: String, default: '' },
          roleCategory: { type: String, default: '' },
          jobRole: { type: String, default: '' },
          desiredJobType: { type: String, default: '' },
          desiredEmploymentType: { type: String, default: '' },
          preferredShift: { type: String, default: '' },
          preferredLocation: { type: String, default: '' },
          expectedSalary: { type: String, default: '' },
        },
        personalDetails: {
          gender: { type: String, default: '' },
          maritalStatus: { type: String, default: '' },
          dob: { type: String, default: '' },
          category: { type: String, default: '' },
          workPermit: { type: String, default: '' },
          address: { type: String, default: '' },
        },
        diversityNote: { type: String, default: '' },
        updatedAt: Date,
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
      coins: { type: Number, default: 0, min: 0 },
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
