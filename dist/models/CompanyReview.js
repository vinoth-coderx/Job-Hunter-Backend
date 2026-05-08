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
exports.CompanyReview = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const ratingsSchema = new mongoose_1.Schema({
    overall: { type: Number, required: true, min: 1, max: 5 },
    culture: { type: Number, min: 1, max: 5 },
    workLifeBalance: { type: Number, min: 1, max: 5 },
    growth: { type: Number, min: 1, max: 5 },
    pay: { type: Number, min: 1, max: 5 },
    management: { type: Number, min: 1, max: 5 },
}, { _id: false });
const interviewExperienceSchema = new mongoose_1.Schema({
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'] },
    result: { type: String, enum: ['got_offer', 'rejected', 'withdrew'] },
    description: { type: String, maxlength: 4000 },
}, { _id: false });
const reviewSchema = new mongoose_1.Schema({
    hirerProfile: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'HirerProfile',
        required: true,
        index: true,
    },
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    application: { type: mongoose_1.Schema.Types.ObjectId, ref: 'AppliedJob', sparse: true },
    isAnonymous: { type: Boolean, default: true },
    reviewerRole: {
        type: String,
        enum: ['candidate', 'employee', 'ex_employee'],
        default: 'candidate',
    },
    ratings: { type: ratingsSchema, required: true },
    title: { type: String, maxlength: 200 },
    pros: { type: String, maxlength: 4000 },
    cons: { type: String, maxlength: 4000 },
    adviceToManagement: { type: String, maxlength: 4000 },
    interviewExperience: { type: interviewExperienceSchema },
    isApproved: { type: Boolean, default: true, index: true },
    helpfulCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });
reviewSchema.index({ hirerProfile: 1, user: 1 }, { unique: true });
reviewSchema.index({ hirerProfile: 1, createdAt: -1 });
exports.CompanyReview = mongoose_1.default.model('CompanyReview', reviewSchema);
