import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IJobView extends Document {
  _id: mongoose.Types.ObjectId;
  job: mongoose.Types.ObjectId;
  user?: mongoose.Types.ObjectId;
  deviceId?: string;
  viewedAt: Date;
}

const jobViewSchema = new Schema<IJobView>(
  {
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
    deviceId: { type: String, index: true, sparse: true, maxlength: 200 },
    viewedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

// TTL — auto-delete views older than 90 days. Cheap analytics
// without growing forever.
jobViewSchema.index({ viewedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
jobViewSchema.index({ job: 1, user: 1, viewedAt: -1 });

export const JobView: Model<IJobView> = mongoose.model<IJobView>('JobView', jobViewSchema);
