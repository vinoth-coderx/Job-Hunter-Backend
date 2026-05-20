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
exports.Report = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const reportSchema = new mongoose_1.Schema({
    reporter: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    subjectType: {
        type: String,
        enum: ['job', 'recruiter', 'message', 'company', 'review'],
        required: true,
        index: true,
    },
    subjectId: { type: mongoose_1.Schema.Types.ObjectId, required: true, index: true },
    reason: {
        type: String,
        enum: [
            'fake_job',
            'fake_recruiter',
            'asks_payment',
            'mlm_scam',
            'misleading_salary',
            'discriminatory',
            'duplicate',
            'harassment',
            'spam',
            'phishing_link',
            'whatsapp_only_contact',
            'other',
        ],
        required: true,
        index: true,
    },
    description: { type: String, maxlength: 2000 },
    evidenceUrls: { type: [String], default: [] },
    status: {
        type: String,
        enum: ['open', 'under_review', 'actioned', 'dismissed'],
        default: 'open',
        index: true,
    },
    resolvedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
    resolutionNote: String,
    action: {
        type: String,
        enum: [
            'job_unpublished',
            'recruiter_warned',
            'recruiter_suspended',
            'recruiter_banned',
            'company_flagged',
            'no_action',
        ],
    },
}, { timestamps: true });
reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ subjectType: 1, subjectId: 1, status: 1 });
exports.Report = mongoose_1.default.model('Report', reportSchema);
