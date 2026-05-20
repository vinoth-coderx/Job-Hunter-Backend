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
exports.SecurityEvent = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const securityEventSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', index: true },
    type: {
        type: String,
        enum: [
            'new_device_login',
            'suspicious_login',
            'impossible_travel',
            'multi_account_link',
            'otp_brute_force',
            'password_brute_force',
            'token_reuse',
            'rate_limit_trip',
            'fraud_signal',
            'malware_upload_blocked',
            'inactivity_logout',
        ],
        required: true,
        index: true,
    },
    severity: {
        type: String,
        enum: ['info', 'low', 'medium', 'high', 'critical'],
        default: 'info',
        index: true,
    },
    ip: String,
    userAgent: String,
    geo: {
        country: String,
        region: String,
        city: String,
        lat: Number,
        lon: Number,
    },
    deviceFingerprint: String,
    metadata: mongoose_1.Schema.Types.Mixed,
    acknowledged: { type: Boolean, default: false, index: true },
    acknowledgedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
    acknowledgedAt: Date,
    resolved: { type: Boolean, default: false, index: true },
    resolvedAt: Date,
    resolutionNote: String,
}, { timestamps: { createdAt: true, updatedAt: false } });
securityEventSchema.index({ createdAt: -1 });
securityEventSchema.index({ severity: 1, acknowledged: 1 });
exports.SecurityEvent = mongoose_1.default.model('SecurityEvent', securityEventSchema);
