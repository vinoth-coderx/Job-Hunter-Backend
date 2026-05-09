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
exports.Job = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const screeningQuestionSchema = new mongoose_1.Schema({
    question: { type: String, required: true, trim: true, maxlength: 500 },
    type: { type: String, enum: ['text', 'mcq', 'yes_no'], required: true },
    options: { type: [String], default: undefined },
    isRequired: { type: Boolean, default: false },
}, { _id: false });
const jobSchema = new mongoose_1.Schema({
    isNative: { type: Boolean, default: false, index: true },
    source: {
        type: String,
        enum: ['native', 'adzuna', 'serpapi', 'rapidapi', 'puppeteer', 'playwright'],
        required: true,
        index: true,
    },
    externalId: { type: String, index: true, sparse: true },
    hirerProfile: { type: mongoose_1.Schema.Types.ObjectId, ref: 'HirerProfile', index: true, sparse: true },
    postedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    company: { type: String, required: true, trim: true, maxlength: 200, index: true },
    companyLogoUrl: String,
    department: { type: String, trim: true, maxlength: 100 },
    location: { type: String, required: true, trim: true, maxlength: 200, index: true },
    description: { type: String, required: true, maxlength: 20000 },
    responsibilities: { type: [String], default: undefined },
    url: { type: String, required: true, maxlength: 2000 },
    salaryMin: { type: Number, min: 0 },
    salaryMax: { type: Number, min: 0 },
    currency: { type: String, default: 'INR', maxlength: 8 },
    isSalaryVisible: { type: Boolean, default: true },
    perks: { type: [String], default: undefined },
    jobType: {
        type: String,
        enum: ['full-time', 'part-time', 'contract', 'internship', 'temporary', 'unknown'],
        default: 'unknown',
    },
    remoteType: {
        type: String,
        enum: ['remote', 'hybrid', 'onsite', 'unknown'],
        default: 'unknown',
    },
    openingsCount: { type: Number, min: 1, default: 1 },
    experienceMinYears: { type: Number, min: 0, max: 60 },
    experienceMaxYears: { type: Number, min: 0, max: 60 },
    education: { type: String, maxlength: 200 },
    skills: { type: [String], default: [], index: true },
    niceToHaveSkills: { type: [String], default: undefined },
    applyType: { type: String, enum: ['easy_apply', 'custom_form'], default: 'easy_apply' },
    requiredDocuments: { type: [String], default: undefined },
    screeningQuestions: { type: [screeningQuestionSchema], default: undefined },
    applicationDeadline: Date,
    status: {
        type: String,
        enum: ['draft', 'active', 'paused', 'closed', 'expired'],
        default: 'active',
        index: true,
    },
    isBoosted: { type: Boolean, default: false, index: true },
    boostExpiresAt: Date,
    viewsCount: { type: Number, default: 0, min: 0 },
    applicationsCount: { type: Number, default: 0, min: 0 },
    shortlistedCount: { type: Number, default: 0, min: 0 },
    scheduledPublishAt: Date,
    publishedAt: Date,
    expiresAt: Date,
    closedAt: Date,
    postedAt: { type: Date, required: true, index: true },
    fetchedAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true, index: true },
    raw: mongoose_1.Schema.Types.Mixed,
}, { timestamps: true });
jobSchema.index({ externalId: 1, source: 1 }, {
    unique: true,
    partialFilterExpression: { externalId: { $exists: true, $type: 'string' } },
});
jobSchema.index({ title: 'text', company: 'text', description: 'text', skills: 'text' });
jobSchema.index({ postedAt: -1, isActive: 1 });
jobSchema.index({ skills: 1, location: 1, jobType: 1 });
jobSchema.index({ status: 1, isNative: 1, postedAt: -1 });
jobSchema.index({ hirerProfile: 1, status: 1, createdAt: -1 });
exports.Job = mongoose_1.default.model('Job', jobSchema);
