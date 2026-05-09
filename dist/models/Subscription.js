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
exports.Subscription = exports.SUBSCRIPTION_PLANS = void 0;
const mongoose_1 = __importStar(require("mongoose"));
exports.SUBSCRIPTION_PLANS = {
    free: {
        tier: 'free',
        name: 'Free',
        priceInr: 0,
        durationDays: 36500,
        features: ['Basic job search', '5 matched jobs/day', 'Email support'],
        jobMatchLimit: 5,
        apiCallLimit: 50,
        prioritySupport: false,
    },
    weekly: {
        tier: 'weekly',
        name: 'Weekly',
        priceInr: 99,
        durationDays: 7,
        features: ['Unlimited matches', 'AI profile match', 'Priority refresh'],
        jobMatchLimit: 100,
        apiCallLimit: 1000,
        prioritySupport: false,
    },
    monthly: {
        tier: 'monthly',
        name: 'Monthly',
        priceInr: 299,
        durationDays: 30,
        features: ['Everything in Weekly', 'Advanced filters', 'Resume insights'],
        jobMatchLimit: 500,
        apiCallLimit: 10000,
        prioritySupport: true,
    },
    yearly: {
        tier: 'yearly',
        name: 'Yearly',
        priceInr: 2499,
        durationDays: 365,
        features: ['Everything in Monthly', 'Save 30%', 'Dedicated support'],
        jobMatchLimit: 10000,
        apiCallLimit: 100000,
        prioritySupport: true,
    },
};
const subscriptionSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tier: {
        type: String,
        enum: ['free', 'weekly', 'monthly', 'yearly'],
        required: true,
    },
    status: {
        type: String,
        enum: ['active', 'expired', 'cancelled', 'refunded'],
        default: 'active',
        index: true,
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true, index: true },
    amountPaid: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    paymentMethod: { type: String, enum: ['razorpay', 'stripe', 'manual'] },
    paymentId: String,
    orderId: String,
    invoiceUrl: String,
    autoRenew: { type: Boolean, default: false },
    cancelledAt: Date,
}, { timestamps: true });
subscriptionSchema.index({ user: 1, status: 1 });
subscriptionSchema.index({ endDate: 1, status: 1 });
subscriptionSchema.index({ paymentId: 1 }, { unique: true, sparse: true });
exports.Subscription = mongoose_1.default.model('Subscription', subscriptionSchema);
