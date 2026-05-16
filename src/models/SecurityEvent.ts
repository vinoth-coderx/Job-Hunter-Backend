import mongoose, { Schema, Document, Model } from 'mongoose';

// Risk-tagged event stream. Distinct from AuditLog: this is for things
// the system *flagged*, not things actors did. Suspicious logins, new
// devices, OTP brute force, multi-account links, etc. Powers the admin
// "Security monitoring" panel and the "Sessions / devices" screen.
export type SecurityEventType =
  | 'new_device_login'
  | 'suspicious_login'
  | 'impossible_travel'
  | 'multi_account_link'
  | 'otp_brute_force'
  | 'password_brute_force'
  | 'token_reuse'
  | 'rate_limit_trip'
  | 'fraud_signal'
  | 'malware_upload_blocked'
  | 'inactivity_logout';

export type SecuritySeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface ISecurityEvent extends Document {
  _id: mongoose.Types.ObjectId;
  user?: mongoose.Types.ObjectId;
  type: SecurityEventType;
  severity: SecuritySeverity;
  ip?: string;
  userAgent?: string;
  geo?: { country?: string; region?: string; city?: string; lat?: number; lon?: number };
  deviceFingerprint?: string;
  metadata?: Record<string, unknown>;
  // Acknowledged means a human (admin) reviewed it; resolved means the
  // underlying signal was handled (e.g. account locked, IP banned).
  acknowledged: boolean;
  acknowledgedBy?: mongoose.Types.ObjectId;
  acknowledgedAt?: Date;
  resolved: boolean;
  resolvedAt?: Date;
  resolutionNote?: string;
  createdAt: Date;
}

const securityEventSchema = new Schema<ISecurityEvent>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    type: {
      type: String,
      enum: [
        'new_device_login',
        'suspicious_login',
        'impossible_travel',
        'multi_account_link',
        'otp_brute_force',
        'password_brute_force',
        'token_reuse',
        'rate_limit_trip',
        'fraud_signal',
        'malware_upload_blocked',
        'inactivity_logout',
      ],
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: ['info', 'low', 'medium', 'high', 'critical'],
      default: 'info',
      index: true,
    },
    ip: String,
    userAgent: String,
    geo: {
      country: String,
      region: String,
      city: String,
      lat: Number,
      lon: Number,
    },
    deviceFingerprint: String,
    metadata: Schema.Types.Mixed,
    acknowledged: { type: Boolean, default: false, index: true },
    acknowledgedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    acknowledgedAt: Date,
    resolved: { type: Boolean, default: false, index: true },
    resolvedAt: Date,
    resolutionNote: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

securityEventSchema.index({ createdAt: -1 });
securityEventSchema.index({ severity: 1, acknowledged: 1 });

export const SecurityEvent: Model<ISecurityEvent> = mongoose.model<ISecurityEvent>(
  'SecurityEvent',
  securityEventSchema,
);
