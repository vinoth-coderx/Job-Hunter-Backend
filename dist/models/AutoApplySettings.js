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
exports.AutoApplySettings = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const preferencesSchema = new mongoose_1.Schema({
    targetRoles: { type: [String], default: [] },
    locations: { type: [String], default: [] },
    isOpenToRemote: { type: Boolean, default: true },
    jobTypes: { type: [String], default: [] },
    minSalary: { type: Number, min: 0 },
    experienceLevels: { type: [String], default: [] },
    sources: {
        type: [String],
        enum: ['native', 'external'],
        default: ['native'],
    },
    companySizes: { type: [String], default: [] },
}, { _id: false });
const matchingRulesSchema = new mongoose_1.Schema({
    minMatchPercentage: { type: Number, min: 50, max: 95, default: 70 },
    minSkillsMatchCount: { type: Number, min: 0, max: 10, default: 2 },
    mustIncludeKeywords: { type: [String], default: [] },
    excludeKeywords: { type: [String], default: [] },
    blacklistedCompanies: { type: [String], default: [] },
    reapplyCooldownDays: {
        type: Number,
        enum: [30, 60, 90],
        default: 60,
    },
}, { _id: false });
const autoApplySettingsSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    isEnabled: { type: Boolean, default: false, index: true },
    isPaused: { type: Boolean, default: false },
    pauseUntil: Date,
    pauseReason: { type: String, maxlength: 500 },
    runTime: { type: String, default: '09:00' },
    runDays: {
        type: [String],
        enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
        default: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    },
    dailyLimit: { type: Number, min: 1, max: 50, default: 10 },
    preferences: { type: preferencesSchema, default: () => ({}) },
    matchingRules: { type: matchingRulesSchema, default: () => ({}) },
    reviewMode: { type: Boolean, default: true },
    aiCoverLetter: {
        enabled: { type: Boolean, default: false },
        tone: {
            type: String,
            enum: ['professional', 'friendly', 'technical'],
            default: 'professional',
        },
        baseTemplate: { type: String, maxlength: 4000 },
    },
    totalAutoApplied: { type: Number, default: 0, min: 0 },
    lastRunAt: Date,
}, { timestamps: true });
exports.AutoApplySettings = mongoose_1.default.model('AutoApplySettings', autoApplySettingsSchema);
