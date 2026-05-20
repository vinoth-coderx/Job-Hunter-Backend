"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.User = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const userSchema = new mongoose_1.Schema({
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
    isPhoneVerified: { type: Boolean, default: false },
    emailVerificationToken: String,
    passwordResetToken: String,
    passwordResetExpires: Date,
    refreshTokens: { type: [String], default: [], select: false },
    twoFactor: {
        enabled: { type: Boolean, default: false, index: true },
        method: {
            type: String,
            enum: ['totp', 'email_otp', 'phone_otp'],
            default: 'totp',
        },
        secretEnc: { type: String, select: false },
        backupCodes: { type: [String], default: [], select: false },
        enrolledAt: Date,
        lastVerifiedAt: Date,
    },
    privacy: {
        openToWork: { type: Boolean, default: false, index: true },
        hideFromCurrentEmployer: { type: Boolean, default: false },
        hidePersonalDetails: { type: Boolean, default: false },
        hideContactUntilShortlisted: { type: Boolean, default: true },
        resumeVisibility: {
            type: String,
            enum: ['public', 'applied_only', 'private'],
            default: 'applied_only',
        },
        searchableInResumeDatabase: { type: Boolean, default: true },
        allowResumeDownload: { type: Boolean, default: true },
    },
    security: {
        registrationIp: String,
        registrationUserAgent: String,
        knownDeviceFingerprints: { type: [String], default: [], select: false },
        knownIps: { type: [String], default: [], select: false },
        lastSeenIp: String,
        failedLoginCount: { type: Number, default: 0 },
        lockedUntil: Date,
        passwordChangedAt: Date,
        requirePasswordReset: { type: Boolean, default: false },
        trustScore: { type: Number, default: 50, min: 0, max: 100, index: true },
    },
    lastActivityAt: Date,
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
        trialActivatedAt: Date,
        trialUsed: { type: Boolean, default: false },
    },
    templateDownloads: {
        count: { type: Number, default: 0, min: 0 },
        periodStart: { type: Date, default: null },
    },
    notificationPreferences: {
        push: { type: Boolean, default: true },
        email: { type: Boolean, default: true },
        whatsapp: { type: Boolean, default: false },
        jobAlerts: { type: Boolean, default: true },
        applicationUpdates: { type: Boolean, default: true },
        autoApplySummary: { type: Boolean, default: true },
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
    aiTopUpCredits: { type: Number, default: 0, min: 0 },
    lastLogin: Date,
    lastRecommendedPushAt: Date,
}, { timestamps: true });
userSchema.pre('save', async function (next) {
    if (!this.isModified('password') || !this.password)
        return next();
    this.password = await bcryptjs_1.default.hash(this.password, 12);
    next();
});
userSchema.methods.comparePassword = async function (candidate) {
    if (!this.password)
        return false;
    return bcryptjs_1.default.compare(candidate, this.password);
};
userSchema.index({ 'profile.skills': 1 });
userSchema.index({ 'subscription.tier': 1, 'subscription.status': 1 });
exports.User = mongoose_1.default.model('User', userSchema);
