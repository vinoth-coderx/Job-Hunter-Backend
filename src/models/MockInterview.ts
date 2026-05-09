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

/// Snapshot of the candidate's profile at the moment the session was
/// started. Lets the AI ground every question in the candidate's actual
/// skills/experience/headline so it doesn't ask the same generic things
/// to every user. Frozen at start so a profile edit mid-interview doesn't
/// retroactively change the prompt context.
export interface ICandidateProfileSnapshot {
  fullName?: string;
  headline?: string;
  experienceYears?: number;
  skills?: string[];
  preferredRoles?: string[];
  resumeExcerpt?: string;
}

export interface IMockInterview extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  role: string;
  interviewType: MockInterviewType;

  candidateProfile?: ICandidateProfileSnapshot;

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
    candidateProfile: {
      fullName: String,
      headline: String,
      experienceYears: Number,
      skills: { type: [String], default: undefined },
      preferredRoles: { type: [String], default: undefined },
      resumeExcerpt: String,
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
