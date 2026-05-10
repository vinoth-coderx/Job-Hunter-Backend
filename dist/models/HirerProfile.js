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
Object.defineProperty(exports, "__esModule", { value: true });
exports.HirerProfile = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const teamMemberSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    role: {
        type: String,
        enum: ['admin', 'recruiter', 'interviewer'],
        required: true,
    },
    addedAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
}, { _id: false });
const hirerProfileSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
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
}, { timestamps: true });
hirerProfileSchema.index({ companyName: 'text', description: 'text' });
exports.HirerProfile = mongoose_1.default.model('HirerProfile', hirerProfileSchema);
