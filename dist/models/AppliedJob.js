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
exports.AppliedJob = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const screeningAnswerSchema = new mongoose_1.Schema({
    question: { type: String, required: true, maxlength: 500 },
    answer: { type: String, required: true, maxlength: 2000 },
}, { _id: false });
const statusHistorySchema = new mongoose_1.Schema({
    status: {
        type: String,
        enum: [
            'applied',
            'viewed',
            'shortlisted',
            'interview',
            'offer',
            'hired',
            'rejected',
            'withdrawn',
        ],
        required: true,
    },
    changedAt: { type: Date, required: true, default: Date.now },
    changedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, maxlength: 1000 },
}, { _id: false });
const appliedJobSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Job', index: true, sparse: true },
    hirerProfile: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'HirerProfile',
        index: true,
        sparse: true,
    },
    jobSnapshot: {
        title: { type: String, required: true },
        company: { type: String, required: true },
        location: { type: String, required: true },
        url: { type: String, required: true },
        description: String,
        salaryMin: Number,
        salaryMax: Number,
        currency: String,
        jobType: String,
        remoteType: String,
        skills: { type: [String], default: undefined },
        companyLogo: String,
        postedAt: Date,
        source: { type: String, required: true, default: 'native' },
        externalId: String,
    },
    applyType: {
        type: String,
        enum: ['one_click', 'custom_form', 'auto_apply', 'external_manual'],
        default: 'external_manual',
    },
    source: {
        type: String,
        enum: ['native', 'indeed', 'naukri', 'linkedin', 'other'],
        default: 'other',
    },
    resumeUrlSnapshot: { type: String, maxlength: 1000 },
    quickNote: { type: String, maxlength: 500 },
    screeningAnswers: { type: [screeningAnswerSchema], default: undefined },
    status: {
        type: String,
        enum: [
            'applied',
            'viewed',
            'shortlisted',
            'interview',
            'offer',
            'hired',
            'rejected',
            'withdrawn',
        ],
        default: 'applied',
        index: true,
    },
    statusHistory: { type: [statusHistorySchema], default: [] },
    matchScore: { type: Number, min: 0, max: 100 },
    aiRanking: {
        type: new mongoose_1.Schema({
            score: { type: Number, min: 0, max: 100, required: true },
            rank: { type: Number, min: 0, required: true },
            summary: { type: String, default: '', maxlength: 500 },
            strengths: { type: [String], default: [] },
            concerns: { type: [String], default: [] },
            rankedAt: { type: Date, default: Date.now },
        }, { _id: false }),
        required: false,
    },
    appliedAt: { type: Date, default: Date.now, index: true },
    notes: { type: String, maxlength: 2000 },
    hirerNotes: { type: String, maxlength: 4000 },
    rejectionReason: { type: String, maxlength: 1000 },
    followUpDate: Date,
}, { timestamps: true });
appliedJobSchema.index({ user: 1, job: 1 }, { unique: true, partialFilterExpression: { job: { $exists: true } } });
appliedJobSchema.index({ user: 1, 'jobSnapshot.source': 1, 'jobSnapshot.externalId': 1 }, { unique: true, partialFilterExpression: { 'jobSnapshot.externalId': { $exists: true } } });
appliedJobSchema.index({ user: 1, status: 1, appliedAt: -1 });
appliedJobSchema.index({ hirerProfile: 1, status: 1, appliedAt: -1 });
appliedJobSchema.index({ job: 1, status: 1, appliedAt: -1 });
exports.AppliedJob = mongoose_1.default.model('AppliedJob', appliedJobSchema);
