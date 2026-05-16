import mongoose, { Schema, Document, Model } from 'mongoose';
import { NotificationType } from '../types';

export interface INotification extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  role: 'seeker' | 'hirer';
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  isRead: boolean;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['seeker', 'hirer'], default: 'seeker', index: true },
    type: {
      type: String,
      enum: [
        'new_job_match',
        'application_status',
        'interview_scheduled',
        'new_message',
        'auto_apply_summary',
        'profile_viewed',
        'subscription_expiry',
        'company_new_job',
        'new_applicant',
        'security',
        'verification',
        'fraud_alert',
        'system',
      ],
      required: true,
      index: true,
    },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 1000 },
    data: { type: Schema.Types.Mixed },
    isRead: { type: Boolean, default: false, index: true },
    readAt: Date,
  },
  { timestamps: true },
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ user: 1, role: 1, createdAt: -1 });

// 60 day retention — push history grows fast otherwise.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 60 });

export const Notification: Model<INotification> = mongoose.model<INotification>(
  'Notification',
  notificationSchema,
);
