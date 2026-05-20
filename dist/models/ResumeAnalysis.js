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
exports.ResumeAnalysis = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const issueSchema = new mongoose_1.Schema({
    category: {
        type: String,
        enum: ['formatting', 'keywords', 'experience', 'skills', 'contact', 'other'],
        required: true,
    },
    severity: { type: String, enum: ['high', 'medium', 'low'], required: true },
    message: { type: String, required: true, maxlength: 400 },
}, { _id: false });
const resumeAnalysisSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Job', index: true },
    contentHash: { type: String, required: true, index: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    matchedSkills: { type: [String], default: [] },
    missingKeywords: { type: [String], default: [] },
    strengths: { type: [String], default: [] },
    weaknesses: { type: [String], default: [] },
    suggestions: { type: [String], default: [] },
    formattingIssues: { type: [issueSchema], default: [] },
    modelTier: { type: String, enum: ['lite', 'smart'] },
    usedAi: { type: Boolean, default: false },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
resumeAnalysisSchema.index({ user: 1, contentHash: 1, createdAt: -1 });
resumeAnalysisSchema.index({ user: 1, createdAt: -1 });
exports.ResumeAnalysis = mongoose_1.default.models.ResumeAnalysis ||
    mongoose_1.default.model('ResumeAnalysis', resumeAnalysisSchema);
