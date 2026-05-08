import mongoose, { Schema, Document, Model } from 'mongoose';

export type InterviewRound =
  | 'hr'
  | 'technical'
  | 'managerial'
  | 'final'
  | 'assessment';
export type InterviewType = 'video' | 'phone' | 'in_person';
export type InterviewStatus =
  | 'scheduled'
  | 'completed'
  | 'cancelled'
  | 'rescheduled'
  | 'no_show';

export interface IInterviewer {
  user?: mongoose.Types.ObjectId;
  name: string;
  designation?: string;
}

export interface IInterviewFeedback {
  rating?: number;
  technicalScore?: number;
  communicationScore?: number;
  culturalFitScore?: number;
  recommendation?: 'strong_yes' | 'yes' | 'maybe' | 'no' | 'strong_no';
  notes?: string;
  submittedAt?: Date;
  submittedBy?: mongoose.Types.ObjectId;
}

export interface IInterview extends Document {
  _id: mongoose.Types.ObjectId;
  application: mongoose.Types.ObjectId;
  job: mongoose.Types.ObjectId;
  seekerUser: mongoose.Types.ObjectId;
  hirerUser: mongoose.Types.ObjectId;
  hirerProfile: mongoose.Types.ObjectId;

  round: InterviewRound;
  interviewType: InterviewType;

  scheduledAt: Date;
  durationMinutes: number;
  timezone: string;

  meetingLink?: string;
  meetingPlatform?: string;
  location?: string;

  interviewers: IInterviewer[];

  notesToCandidate?: string;
  notesToInterviewer?: string;

  status: InterviewStatus;
  feedback?: IInterviewFeedback;

  inviteSentAt?: Date;
  candidateConfirmed: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const interviewerSchema = new Schema<IInterviewer>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    name: { type: String, required: true, maxlength: 100 },
    designation: { type: String, maxlength: 100 },
  },
  { _id: false },
);

const feedbackSchema = new Schema<IInterviewFeedback>(
  {
    rating: { type: Number, min: 1, max: 5 },
    technicalScore: { type: Number, min: 0, max: 100 },
    communicationScore: { type: Number, min: 0, max: 100 },
    culturalFitScore: { type: Number, min: 0, max: 100 },
    recommendation: {
      type: String,
      enum: ['strong_yes', 'yes', 'maybe', 'no', 'strong_no'],
    },
    notes: { type: String, maxlength: 4000 },
    submittedAt: Date,
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false },
);

const interviewSchema = new Schema<IInterview>(
  {
    application: {
      type: Schema.Types.ObjectId,
      ref: 'AppliedJob',
      required: true,
      index: true,
    },
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    seekerUser: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    hirerUser: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    hirerProfile: {
      type: Schema.Types.ObjectId,
      ref: 'HirerProfile',
      required: true,
      index: true,
    },

    round: {
      type: String,
      enum: ['hr', 'technical', 'managerial', 'final', 'assessment'],
      default: 'hr',
    },
    interviewType: {
      type: String,
      enum: ['video', 'phone', 'in_person'],
      default: 'video',
    },

    scheduledAt: { type: Date, required: true, index: true },
    durationMinutes: { type: Number, default: 45, min: 5, max: 480 },
    timezone: { type: String, default: 'Asia/Kolkata' },

    meetingLink: { type: String, maxlength: 1000 },
    meetingPlatform: { type: String, maxlength: 50 },
    location: { type: String, maxlength: 500 },

    interviewers: { type: [interviewerSchema], default: [] },

    notesToCandidate: { type: String, maxlength: 2000 },
    notesToInterviewer: { type: String, maxlength: 2000 },

    status: {
      type: String,
      enum: ['scheduled', 'completed', 'cancelled', 'rescheduled', 'no_show'],
      default: 'scheduled',
      index: true,
    },
    feedback: { type: feedbackSchema },

    inviteSentAt: Date,
    candidateConfirmed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

interviewSchema.index({ seekerUser: 1, scheduledAt: 1 });
interviewSchema.index({ hirerUser: 1, scheduledAt: 1 });
interviewSchema.index({ hirerProfile: 1, scheduledAt: 1, status: 1 });

export const Interview: Model<IInterview> = mongoose.model<IInterview>(
  'Interview',
  interviewSchema,
);
