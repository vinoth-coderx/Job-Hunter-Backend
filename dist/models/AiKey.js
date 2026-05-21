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
exports.AiKey = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const aiKeySchema = new mongoose_1.Schema({
    provider: {
        type: String,
        enum: ['gemini', 'groq'],
        required: true,
        index: true,
    },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    apiKeyEncrypted: { type: String, required: true, select: false },
    model: { type: String, required: true, trim: true, maxlength: 80 },
    baseUrl: { type: String, trim: true, maxlength: 200 },
    priority: { type: Number, default: 10, min: 0, max: 1000 },
    weight: { type: Number, default: 1, min: 0, max: 1000 },
    tier: { type: String, enum: ['free', 'paid'], default: 'free' },
    dailyLimit: { type: Number, default: 400, min: 0 },
    rpmLimit: { type: Number, default: 60, min: 0 },
    maxTokens: { type: Number, min: 0 },
    temperature: { type: Number, min: 0, max: 2 },
    allowedFeatures: { type: [String], default: [] },
    notes: { type: String, maxlength: 500 },
    isActive: { type: Boolean, default: true, index: true },
    usageToday: { type: Number, default: 0 },
    lastUsedAt: Date,
    createdBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true, versionKey: false });
aiKeySchema.index({ provider: 1, priority: 1, isActive: 1 });
exports.AiKey = mongoose_1.default.models.AiKey || mongoose_1.default.model('AiKey', aiKeySchema);
