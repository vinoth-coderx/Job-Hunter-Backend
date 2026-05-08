import mongoose, { Schema, Document, Model } from 'mongoose';

export type MessageType = 'text' | 'file' | 'interview_invite' | 'system';

export interface IMessage extends Document {
  _id: mongoose.Types.ObjectId;
  conversation: mongoose.Types.ObjectId;
  sender: mongoose.Types.ObjectId;
  receiver: mongoose.Types.ObjectId;

  type: MessageType;
  content: string;

  file?: {
    url: string;
    filename: string;
    sizeBytes: number;
    type: string;
  };

  isRead: boolean;
  readAt?: Date;
  sentAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    receiver: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: {
      type: String,
      enum: ['text', 'file', 'interview_invite', 'system'],
      default: 'text',
    },
    content: { type: String, required: true, maxlength: 4000 },

    file: {
      url: { type: String, maxlength: 1000 },
      filename: { type: String, maxlength: 200 },
      sizeBytes: { type: Number, min: 0 },
      type: { type: String, maxlength: 100 },
    },

    isRead: { type: Boolean, default: false, index: true },
    readAt: Date,
    sentAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

messageSchema.index({ conversation: 1, sentAt: -1 });

// 1-year retention. Job-hunter chat doesn't need to be a forever archive,
// and unbounded growth ages slow on the conversations list lookup.
messageSchema.index({ sentAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

export const Message: Model<IMessage> = mongoose.model<IMessage>('Message', messageSchema);
