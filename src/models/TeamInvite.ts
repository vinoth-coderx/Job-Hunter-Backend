import mongoose, { Schema, Document, Model } from 'mongoose';

export type TeamRole = 'admin' | 'recruiter' | 'interviewer';

export interface ITeamInvite extends Document {
  _id: mongoose.Types.ObjectId;
  hirerProfile: mongoose.Types.ObjectId;
  invitedBy: mongoose.Types.ObjectId;
  email: string;
  role: TeamRole;
  // 32-byte hex token (64 chars) the invitee uses to accept.
  token: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: Date;
  acceptedAt?: Date;
  acceptedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const inviteSchema = new Schema<ITeamInvite>(
  {
    hirerProfile: {
      type: Schema.Types.ObjectId,
      ref: 'HirerProfile',
      required: true,
      index: true,
    },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 200,
      index: true,
    },
    role: {
      type: String,
      enum: ['admin', 'recruiter', 'interviewer'],
      default: 'recruiter',
    },
    token: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'revoked', 'expired'],
      default: 'pending',
      index: true,
    },
    expiresAt: { type: Date, required: true },
    acceptedAt: Date,
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// One pending invite per (company, email) — re-inviting the same address
// updates the existing pending invite rather than spamming.
inviteSchema.index(
  { hirerProfile: 1, email: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
  },
);
// Auto-expire pending invites 14 days after createdAt.
inviteSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);

export const TeamInvite: Model<ITeamInvite> = mongoose.model<ITeamInvite>(
  'TeamInvite',
  inviteSchema,
);
