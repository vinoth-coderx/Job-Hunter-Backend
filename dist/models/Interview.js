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
exports.Interview = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const interviewerSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
    name: { type: String, required: true, maxlength: 100 },
    designation: { type: String, maxlength: 100 },
}, { _id: false });
const feedbackSchema = new mongoose_1.Schema({
    rating: { type: Number, min: 1, max: 5 },
    technicalScore: { type: Number, min: 0, max: 100 },
    communicationScore: { type: Number, min: 0, max: 100 },
    culturalFitScore: { type: Number, min: 0, max: 100 },
    recommendation: {
        type: String,
        enum: ['strong_yes', 'yes', 'maybe', 'no', 'strong_no'],
    },
    notes: { type: String, maxlength: 4000 },
    submittedAt: Date,
    submittedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });
const interviewSchema = new mongoose_1.Schema({
    application: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'AppliedJob',
        required: true,
        index: true,
    },
    job: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    seekerUser: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    hirerUser: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    hirerProfile: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'HirerProfile',
        required: true,
        index: true,
    },
    round: {
        type: String,
        enum: ['hr', 'technical', 'managerial', 'final', 'assessment'],
        default: 'hr',
    },
    interviewType: {
        type: String,
        enum: ['video', 'phone', 'in_person'],
        default: 'video',
    },
    scheduledAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 45, min: 5, max: 480 },
    timezone: { type: String, default: 'Asia/Kolkata' },
    meetingLink: { type: String, maxlength: 1000 },
    meetingPlatform: { type: String, maxlength: 50 },
    location: { type: String, maxlength: 500 },
    interviewers: { type: [interviewerSchema], default: [] },
    notesToCandidate: { type: String, maxlength: 2000 },
    notesToInterviewer: { type: String, maxlength: 2000 },
    status: {
        type: String,
        enum: ['scheduled', 'completed', 'cancelled', 'rescheduled', 'no_show'],
        default: 'scheduled',
        index: true,
    },
    feedback: { type: feedbackSchema },
    inviteSentAt: Date,
    candidateConfirmed: { type: Boolean, default: false },
}, { timestamps: true });
interviewSchema.index({ seekerUser: 1, scheduledAt: 1 });
interviewSchema.index({ hirerUser: 1, scheduledAt: 1 });
interviewSchema.index({ hirerProfile: 1, scheduledAt: 1, status: 1 });
exports.Interview = mongoose_1.default.model('Interview', interviewSchema);
