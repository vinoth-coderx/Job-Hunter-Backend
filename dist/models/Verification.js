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
exports.Verification = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const verificationSchema = new mongoose_1.Schema({
    hirer: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    company: { type: mongoose_1.Schema.Types.ObjectId, ref: 'HirerProfile', required: true, index: true },
    channel: {
        type: String,
        enum: ['gst', 'domain_email', 'website', 'linkedin', 'identity'],
        required: true,
        index: true,
    },
    status: {
        type: String,
        enum: ['pending', 'auto_verified', 'approved', 'rejected', 'expired'],
        default: 'pending',
        index: true,
    },
    payload: {
        gstNumber: { type: String, trim: true, maxlength: 32 },
        domainEmail: { type: String, trim: true, lowercase: true },
        domainEmailVerifiedAt: Date,
        website: { type: String, trim: true, maxlength: 500 },
        websiteFileToken: String,
        websiteVerifiedAt: Date,
        linkedinUrl: { type: String, maxlength: 500 },
        identityDocUrl: String,
        identityDocType: {
            type: String,
            enum: ['pan', 'aadhaar', 'passport', 'driving_license'],
        },
    },
    reviewNote: { type: String, maxlength: 2000 },
    reviewedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    expiresAt: Date,
}, { timestamps: true });
verificationSchema.index({ status: 1, createdAt: -1 });
verificationSchema.index({ company: 1, channel: 1 });
exports.Verification = mongoose_1.default.model('Verification', verificationSchema);
