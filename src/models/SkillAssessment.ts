import mongoose, { Schema, Document, Model } from 'mongoose';

export type AssessmentLevel = 'beginner' | 'intermediate' | 'advanced';

export interface ISkillAssessmentQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
}

export interface ISkillAssessmentAnswer {
  questionIndex: number;
  selectedIndex: number;
  isCorrect: boolean;
}

export interface ISkillAssessment extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  skill: string;
  level: AssessmentLevel;

  questions: ISkillAssessmentQuestion[];
  // Answers map 1:1 to `questions` by index. May be empty until the user
  // submits.
  answers: ISkillAssessmentAnswer[];

  questionsAttempted: number;
  correctAnswers: number;
  scorePercent: number;
  timeTakenSeconds: number;
  passingScore: number;
  isPassed: boolean;
  badgeAwarded: boolean;

  startedAt: Date;
  completedAt?: Date;
  createdAt: Date;
}

const questionSchema = new Schema<ISkillAssessmentQuestion>(
  {
    question: { type: String, required: true, maxlength: 1000 },
    options: {
      type: [String],
      required: true,
      validate: {
        validator: (a: string[]) => a.length >= 2 && a.length <= 5,
        message: 'Options must have 2–5 entries',
      },
    },
    correctIndex: { type: Number, required: true, min: 0 },
    explanation: { type: String, maxlength: 1000 },
  },
  { _id: false },
);

const answerSchema = new Schema<ISkillAssessmentAnswer>(
  {
    questionIndex: { type: Number, required: true, min: 0 },
    selectedIndex: { type: Number, required: true, min: 0 },
    isCorrect: { type: Boolean, required: true },
  },
  { _id: false },
);

const assessmentSchema = new Schema<ISkillAssessment>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    skill: { type: String, required: true, lowercase: true, trim: true, maxlength: 100, index: true },
    level: {
      type: String,
      enum: ['beginner', 'intermediate', 'advanced'],
      default: 'intermediate',
    },

    questions: {
      type: [questionSchema],
      validate: {
        validator: (a: ISkillAssessmentQuestion[]) =>
          a.length >= 5 && a.length <= 20,
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
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

assessmentSchema.index({ user: 1, skill: 1, completedAt: -1 });

export const SkillAssessment: Model<ISkillAssessment> = mongoose.model<ISkillAssessment>(
  'SkillAssessment',
  assessmentSchema,
);
