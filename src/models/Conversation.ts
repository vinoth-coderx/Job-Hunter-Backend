import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IConversation extends Document {
  _id: mongoose.Types.ObjectId;
  participants: mongoose.Types.ObjectId[];
  application?: mongoose.Types.ObjectId;
  job?: mongoose.Types.ObjectId;

  lastMessage?: {
    content: string;
    sentAt: Date;
    sender: mongoose.Types.ObjectId;
  };

  // unreadCount keyed by user id (string). A Map is the right shape for
  // Mongoose to keep the keys typed.
  unreadCount: Map<string, number>;

  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new Schema<IConversation>(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
      validate: {
        // Allow 1 (notes-to-self / single-account testing) or 2 participants.
        validator: (arr: unknown[]) => arr.length === 1 || arr.length === 2,
        message: 'A conversation must have 1 or 2 participants',
      },
      index: true,
    },
    application: { type: Schema.Types.ObjectId, ref: 'AppliedJob', sparse: true },
    job: { type: Schema.Types.ObjectId, ref: 'Job', sparse: true },

    lastMessage: {
      content: { type: String, maxlength: 2000 },
      sentAt: Date,
      sender: { type: Schema.Types.ObjectId, ref: 'User' },
    },

    unreadCount: {
      type: Map,
      of: { type: Number, min: 0, default: 0 },
      default: () => new Map<string, number>(),
    },

    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Used by the "find existing conversation between A and B" query.
// `$all` against an indexed array hits this index.
conversationSchema.index({ participants: 1, updatedAt: -1 });

export const Conversation: Model<IConversation> = mongoose.model<IConversation>(
  'Conversation',
  conversationSchema,
);
