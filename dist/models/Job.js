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
exports.Job = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const jobSchema = new mongoose_1.Schema({
    externalId: { type: String, required: true, index: true },
    source: {
        type: String,
        enum: ['adzuna', 'serpapi', 'rapidapi', 'puppeteer', 'playwright'],
        required: true,
        index: true,
    },
    title: { type: String, required: true, trim: true, index: 'text' },
    company: { type: String, required: true, trim: true, index: true },
    location: { type: String, required: true, trim: true, index: true },
    description: { type: String, required: true, index: 'text' },
    url: { type: String, required: true },
    salaryMin: Number,
    salaryMax: Number,
    currency: String,
    jobType: {
        type: String,
        enum: ['full-time', 'part-time', 'contract', 'internship', 'temporary', 'unknown'],
        default: 'unknown',
    },
    remoteType: {
        type: String,
        enum: ['remote', 'hybrid', 'onsite', 'unknown'],
        default: 'unknown',
    },
    skills: { type: [String], default: [], index: true },
    postedAt: { type: Date, required: true, index: true },
    fetchedAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true, index: true },
    raw: mongoose_1.Schema.Types.Mixed,
}, { timestamps: true });
jobSchema.index({ externalId: 1, source: 1 }, { unique: true });
jobSchema.index({ title: 'text', company: 'text', description: 'text', skills: 'text' });
jobSchema.index({ postedAt: -1, isActive: 1 });
jobSchema.index({ skills: 1, location: 1, jobType: 1 });
exports.Job = mongoose_1.default.model('Job', jobSchema);
