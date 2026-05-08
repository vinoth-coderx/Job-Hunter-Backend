import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ISavedJob extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  job: mongoose.Types.ObjectId;
  savedAt: Date;
}

const savedJobSchema = new Schema<ISavedJob>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    job: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    savedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

savedJobSchema.index({ user: 1, job: 1 }, { unique: true });
savedJobSchema.index({ user: 1, savedAt: -1 });

export const SavedJob: Model<ISavedJob> = mongoose.model<ISavedJob>('SavedJob', savedJobSchema);
