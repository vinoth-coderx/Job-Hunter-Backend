import mongoose, { Schema, Document, Model } from 'mongoose';

export type DevicePlatform = 'ios' | 'android' | 'web';

export interface IDeviceToken extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  token: string;
  platform: DevicePlatform;
  appVersion?: string;
  /// Updated every time the client re-registers; the cron uses this to
  /// skip pushing to devices that haven't checked in for >30 days.
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const deviceTokenSchema = new Schema<IDeviceToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ['ios', 'android', 'web'], required: true },
    appVersion: String,
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

deviceTokenSchema.index({ user: 1, platform: 1 });

export const DeviceToken: Model<IDeviceToken> = mongoose.model<IDeviceToken>(
  'DeviceToken',
  deviceTokenSchema,
);
