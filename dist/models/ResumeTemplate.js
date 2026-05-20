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
exports.ResumeTemplate = exports.MIN_PUBLISH_ATS_SCORE = void 0;
const mongoose_1 = __importStar(require("mongoose"));
exports.MIN_PUBLISH_ATS_SCORE = 60;
const templateSchema = new mongoose_1.Schema({
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 400 },
    category: { type: String, default: 'general', trim: true, lowercase: true },
    htmlOriginal: { type: String, required: true },
    htmlEnhanced: { type: String, default: null },
    liveSource: {
        type: String,
        enum: ['original', 'enhanced'],
        default: 'original',
    },
    previewImageUrl: { type: String, default: null },
    atsScore: { type: Number, default: 0, min: 0, max: 100 },
    atsScoreSource: {
        type: String,
        enum: ['ai', 'heuristic', 'unscored'],
        default: 'unscored',
    },
    atsNotes: { type: [String], default: [] },
    status: {
        type: String,
        enum: ['draft', 'enhanced', 'published', 'archived'],
        default: 'draft',
        index: true,
    },
    isPremium: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 100 },
    createdBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
templateSchema.index({ status: 1, sortOrder: 1 });
templateSchema.index({ category: 1, status: 1 });
exports.ResumeTemplate = mongoose_1.default.models.ResumeTemplate ||
    mongoose_1.default.model('ResumeTemplate', templateSchema);
