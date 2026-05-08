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
exports.SkillAssessment = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const questionSchema = new mongoose_1.Schema({
    question: { type: String, required: true, maxlength: 1000 },
    options: {
        type: [String],
        required: true,
        validate: {
            validator: (a) => a.length >= 2 && a.length <= 5,
            message: 'Options must have 2–5 entries',
        },
    },
    correctIndex: { type: Number, required: true, min: 0 },
    explanation: { type: String, maxlength: 1000 },
}, { _id: false });
const answerSchema = new mongoose_1.Schema({
    questionIndex: { type: Number, required: true, min: 0 },
    selectedIndex: { type: Number, required: true, min: 0 },
    isCorrect: { type: Boolean, required: true },
}, { _id: false });
const assessmentSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    skill: { type: String, required: true, lowercase: true, trim: true, maxlength: 100, index: true },
    level: {
        type: String,
        enum: ['beginner', 'intermediate', 'advanced'],
        default: 'intermediate',
    },
    questions: {
        type: [questionSchema],
        validate: {
            validator: (a) => a.length >= 5 && a.length <= 20,
            message: 'Assessment must have 5–20 questions',
        },
    },
    answers: { type: [answerSchema], default: [] },
    questionsAttempted: { type: Number, default: 0, min: 0 },
    correctAnswers: { type: Number, default: 0, min: 0 },
    scorePercent: { type: Number, default: 0, min: 0, max: 100 },
    timeTakenSeconds: { type: Number, default: 0, min: 0 },
    passingScore: { type: Number, default: 70, min: 0, max: 100 },
    isPassed: { type: Boolean, default: false, index: true },
    badgeAwarded: { type: Boolean, default: false },
    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
}, { timestamps: { createdAt: true, updatedAt: false } });
assessmentSchema.index({ user: 1, skill: 1, completedAt: -1 });
exports.SkillAssessment = mongoose_1.default.model('SkillAssessment', assessmentSchema);
