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
exports.SubscriptionPlan = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const planSchema = new mongoose_1.Schema({
    tier: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    priceInr: { type: Number, required: true, min: 0 },
    durationDays: { type: Number, required: true, min: 1 },
    features: { type: [String], default: [] },
    jobMatchLimit: { type: Number, default: 0, min: 0 },
    apiCallLimit: { type: Number, default: 0, min: 0 },
    prioritySupport: { type: Boolean, default: false },
    coinCost: { type: Number, default: null, min: 0 },
    templateDownloadsPerMonth: { type: Number, default: 0, min: -1 },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 100 },
    badge: { type: String, default: null, trim: true },
}, { timestamps: true });
planSchema.index({ isActive: 1, sortOrder: 1 });
exports.SubscriptionPlan = mongoose_1.default.models.SubscriptionPlan ||
    mongoose_1.default.model('SubscriptionPlan', planSchema);
