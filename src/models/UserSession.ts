import mongoose, { Schema, Document, Model } from 'mongoose';

// One row per active login. Drives "Sessions / devices" UI, "log out
// everywhere", auto-logout-on-inactivity, and the new-device-alert
// pipeline. The refresh-token jti is hashed; the raw value is only ever
// returned to the client at login time.
export interface IUserSession extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  refreshTokenHash: string;
  deviceFingerprint?: string;
  deviceLabel?: string;
  platform?: 'android' | 'ios' | 'web' | 'admin_web' | 'unknown';
  appVersion?: string;
  ip?: string;
  userAgent?: string;
  geo?: { country?: string; region?: string; city?: string; lat?: number; lon?: number };
  trusted: boolean;
  lastActivityAt: Date;
  revokedAt?: Date;
  revokedReason?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSessionSchema = new Schema<IUserSession>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    refreshTokenHash: { type: String, required: true, index: true, select: false },
    deviceFingerprint: { type: String, index: true },
    deviceLabel: String,
    platform: {
      type: String,
      enum: ['android', 'ios', 'web', 'admin_web', 'unknown'],
      default: 'unknown',
    },
    appVersion: String,
    ip: String,
    userAgent: String,
    geo: {
      country: String,
      region: String,
      city: String,
      lat: Number,
      lon: Number,
    },
    trusted: { type: Boolean, default: false, index: true },
    lastActivityAt: { type: Date, default: Date.now, index: true },
    revokedAt: Date,
    revokedReason: String,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

userSessionSchema.index({ user: 1, revokedAt: 1, lastActivityAt: -1 });
userSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UserSession: Model<IUserSession> = mongoose.model<IUserSession>(
  'UserSession',
  userSessionSchema,
);
