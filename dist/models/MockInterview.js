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
exports.MockInterview = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const turnSchema = new mongoose_1.Schema({
    role: {
        type: String,
        enum: ['interviewer', 'candidate'],
        required: true,
    },
    text: { type: String, required: true, maxlength: 8000 },
    feedback: {
        relevance: { type: Number, min: 0, max: 100 },
        depth: { type: Number, min: 0, max: 100 },
        communication: { type: Number, min: 0, max: 100 },
        suggestion: { type: String, maxlength: 1000 },
    },
    at: { type: Date, default: Date.now },
}, { _id: false });
const mockInterviewSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, required: true, trim: true, maxlength: 100 },
    interviewType: {
        type: String,
        enum: ['hr', 'technical', 'behavioural', 'system_design'],
        default: 'behavioural',
    },
    candidateProfile: {
        fullName: String,
        headline: String,
        experienceYears: Number,
        skills: { type: [String], default: undefined },
        preferredRoles: { type: [String], default: undefined },
        resumeExcerpt: String,
    },
    turns: { type: [turnSchema], default: [] },
    questionsAsked: { type: Number, default: 0, min: 0 },
    questionsTarget: { type: Number, default: 6, min: 3, max: 15 },
    isCompleted: { type: Boolean, default: false, index: true },
    finalScore: { type: Number, min: 0, max: 100 },
    finalSummary: { type: String, maxlength: 4000 },
    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
}, { timestamps: true });
mockInterviewSchema.index({ user: 1, createdAt: -1 });
exports.MockInterview = mongoose_1.default.model('MockInterview', mockInterviewSchema);
