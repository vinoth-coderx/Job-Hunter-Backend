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
exports.AiUsageLog = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const aiUsageLogSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', index: true },
    feature: { type: String, required: true, index: true, maxlength: 60 },
    provider: {
        type: String,
        enum: ['gemini', 'claude', 'groq'],
        required: true,
        index: true,
    },
    tier: { type: String, enum: ['lite', 'smart'], required: true },
    inputTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
    totalTokens: { type: Number, default: 0, min: 0 },
    estimatedCostUsd: { type: Number, default: 0, min: 0 },
    latencyMs: { type: Number, default: 0, min: 0 },
    success: { type: Boolean, default: true, index: true },
    errorCode: { type: String, maxlength: 60 },
    cacheHit: { type: Boolean, default: false, index: true },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
aiUsageLogSchema.index({ createdAt: -1 });
aiUsageLogSchema.index({ feature: 1, createdAt: -1 });
aiUsageLogSchema.index({ provider: 1, createdAt: -1 });
aiUsageLogSchema.index({ user: 1, createdAt: -1 });
aiUsageLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
exports.AiUsageLog = mongoose_1.default.models.AiUsageLog ||
    mongoose_1.default.model('AiUsageLog', aiUsageLogSchema);
