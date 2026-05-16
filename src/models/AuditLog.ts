import mongoose, { Schema, Document, Model } from 'mongoose';

// Append-only ledger of consequential actions taken across the platform.
// Powers /admin/audit-logs and is the source of truth for any "who did
// what, when" investigation. Never mutated after insert.
export type AuditActorType = 'user' | 'hirer' | 'admin' | 'system';
export type AuditCategory =
  | 'auth'
  | 'admin'
  | 'hirer'
  | 'job_moderation'
  | 'verification'
  | 'security'
  | 'subscription'
  | 'data_export'
  | 'data_delete';

export interface IAuditLog extends Document {
  _id: mongoose.Types.ObjectId;
  actor?: mongoose.Types.ObjectId;
  actorType: AuditActorType;
  actorEmail?: string;
  category: AuditCategory;
  action: string;
  target?: {
    type: string;
    id?: mongoose.Types.ObjectId;
    label?: string;
  };
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  outcome: 'success' | 'failure';
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    actorType: {
      type: String,
      enum: ['user', 'hirer', 'admin', 'system'],
      required: true,
      index: true,
    },
    actorEmail: String,
    category: {
      type: String,
      enum: [
        'auth',
        'admin',
        'hirer',
        'job_moderation',
        'verification',
        'security',
        'subscription',
        'data_export',
        'data_delete',
      ],
      required: true,
      index: true,
    },
    action: { type: String, required: true, maxlength: 120, index: true },
    target: {
      type: { type: String },
      id: Schema.Types.ObjectId,
      label: String,
    },
    metadata: Schema.Types.Mixed,
    ip: String,
    userAgent: String,
    outcome: {
      type: String,
      enum: ['success', 'failure'],
      default: 'success',
      index: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ category: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });

export const AuditLog: Model<IAuditLog> = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
