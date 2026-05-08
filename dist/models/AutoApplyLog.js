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
exports.AutoApplyLog = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const appliedEntrySchema = new mongoose_1.Schema({
    job: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Job', required: true },
    application: { type: mongoose_1.Schema.Types.ObjectId, ref: 'AppliedJob' },
    companyName: { type: String, required: true },
    jobTitle: { type: String, required: true },
    matchScore: { type: Number, required: true, min: 0, max: 100 },
    source: { type: String, enum: ['native', 'external'], required: true },
    appliedAt: { type: Date, required: true },
    coverLetterUsed: { type: Boolean, default: false },
    status: { type: String, default: 'applied' },
}, { _id: false });
const skippedEntrySchema = new mongoose_1.Schema({
    job: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Job', required: true },
    reason: {
        type: String,
        enum: [
            'blacklisted',
            'below_match',
            'already_applied',
            'cooldown',
            'keyword_excluded',
            'missing_required_skills',
            'salary_below_threshold',
            'limit_reached',
        ],
        required: true,
    },
    matchScore: { type: Number, min: 0, max: 100 },
}, { _id: false });
const autoApplyLogSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    runDate: { type: Date, required: true, index: true },
    jobsScanned: { type: Number, default: 0, min: 0 },
    jobsMatched: { type: Number, default: 0, min: 0 },
    jobsApplied: { type: Number, default: 0, min: 0 },
    jobsSkipped: { type: Number, default: 0, min: 0 },
    appliedJobs: { type: [appliedEntrySchema], default: [] },
    skippedJobs: { type: [skippedEntrySchema], default: [] },
    awaitingApproval: { type: Boolean, default: false, index: true },
    approvalCompletedAt: Date,
    notificationSent: { type: Boolean, default: false },
    triggeredManually: { type: Boolean, default: false },
}, { timestamps: { createdAt: true, updatedAt: false } });
autoApplyLogSchema.index({ user: 1, runDate: -1 });
autoApplyLogSchema.index({ runDate: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });
exports.AutoApplyLog = mongoose_1.default.model('AutoApplyLog', autoApplyLogSchema);
