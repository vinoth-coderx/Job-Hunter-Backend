import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ICompanyFollow extends Document {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  hirerProfile: mongoose.Types.ObjectId;
  followedAt: Date;
}

const companyFollowSchema = new Schema<ICompanyFollow>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    hirerProfile: {
      type: Schema.Types.ObjectId,
      ref: 'HirerProfile',
      required: true,
      index: true,
    },
    followedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

companyFollowSchema.index({ user: 1, hirerProfile: 1 }, { unique: true });

export const CompanyFollow: Model<ICompanyFollow> = mongoose.model<ICompanyFollow>(
  'CompanyFollow',
  companyFollowSchema,
);
