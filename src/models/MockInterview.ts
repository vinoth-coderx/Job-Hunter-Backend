import mongoose, { Schema, Document, Model } from 'mongoose';

export type MockInterviewType = 'hr' | 'technical' | 'behavioural' | 'system_design';

export interface IMockInterviewTurn {
  role: 'interviewer' | 'candidate';
  text: string;
  // Per-answer scores filled in by the LLM scorer.
  feedback?: {
    relevance?: number; // 0-100
    depth?: number; // 0-100
    communication?: number; // 0-100
    suggestion?: string;
  };
  at: Date;
}

export interface IMockInterview extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  role: string;
  interviewType: MockInterviewType;

  turns: IMockInterviewTurn[];
  questionsAsked: number;
  questionsTarget: number;

  isCompleted: boolean;
  finalScore?: number;
  finalSummary?: string;

  startedAt: Date;
  completedAt?: Date;
}

const turnSchema = new Schema<IMockInterviewTurn>(
  {
    role: {
      type: String,
      enum: ['interviewer', 'candidate'],
      required: true,
    },
    text: { type: String, required: true, maxlength: 8000 },
    feedback: {
      relevance: { type: Number, min: 0, max: 100 },
      depth: { type: Number, min: 0, max: 100 },
      communication: { type: Number, min: 0, max: 100 },
      suggestion: { type: String, maxlength: 1000 },
    },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const mockInterviewSchema = new Schema<IMockInterview>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, required: true, trim: true, maxlength: 100 },
    interviewType: {
      type: String,
      enum: ['hr', 'technical', 'behavioural', 'system_design'],
      default: 'behavioural',
    },
    turns: { type: [turnSchema], default: [] },
    questionsAsked: { type: Number, default: 0, min: 0 },
    questionsTarget: { type: Number, default: 6, min: 3, max: 15 },
    isCompleted: { type: Boolean, default: false, index: true },
    finalScore: { type: Number, min: 0, max: 100 },
    finalSummary: { type: String, maxlength: 4000 },
    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
  },
  { timestamps: true },
);

mockInterviewSchema.index({ user: 1, createdAt: -1 });

export const MockInterview: Model<IMockInterview> =
  mongoose.model<IMockInterview>('MockInterview', mockInterviewSchema);
