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
exports.JobModeration = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const jobModerationSchema = new mongoose_1.Schema({
    job: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    hirer: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    company: { type: mongoose_1.Schema.Types.ObjectId, ref: 'HirerProfile' },
    riskScore: { type: Number, required: true, min: 0, max: 100, index: true },
    decision: {
        type: String,
        enum: ['auto_approved', 'queued', 'auto_rejected'],
        required: true,
        index: true,
    },
    flags: {
        type: [String],
        enum: [
            'scam_keywords',
            'fake_salary',
            'suspicious_url',
            'whatsapp_only_contact',
            'telegram_only_contact',
            'asks_payment',
            'mlm_pattern',
            'discriminatory_language',
            'duplicate_content',
            'low_recruiter_trust',
            'missing_company_verification',
        ],
        default: [],
    },
    contentHash: { type: String, required: true, index: true },
    duplicateOf: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Job' },
    reasoning: String,
    modelTier: String,
    reviewedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    overrideDecision: { type: String, enum: ['approved', 'rejected'] },
    overrideNote: String,
    appeal: {
        type: new mongoose_1.Schema({
            submittedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
            reason: { type: String, required: true, maxlength: 2000 },
            submittedAt: { type: Date, default: Date.now },
            status: {
                type: String,
                enum: ['pending', 'accepted', 'rejected'],
                default: 'pending',
            },
            adminNote: { type: String, maxlength: 2000 },
            resolvedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
            resolvedAt: Date,
        }, { _id: false }),
        required: false,
    },
}, { timestamps: { createdAt: true, updatedAt: false } });
jobModerationSchema.index({ 'appeal.status': 1, createdAt: -1 });
jobModerationSchema.index({ decision: 1, createdAt: -1 });
jobModerationSchema.index({ hirer: 1, createdAt: -1 });
exports.JobModeration = mongoose_1.default.model('JobModeration', jobModerationSchema);
