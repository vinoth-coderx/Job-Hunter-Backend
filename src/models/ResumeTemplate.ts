import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Admin-uploaded resume template. Stored as a single HTML document with
 * a small set of Mustache-style placeholders (`{{fullName}}`, `{{email}}`,
 * `{{skills}}`, etc.) that the user-fill step substitutes at render time.
 *
 * Two HTML fields are kept:
 *   - `htmlOriginal`  : exactly what the admin uploaded
 *   - `htmlEnhanced`  : the AI-improved version the admin accepted
 *
 * Only one of these is the live copy and that choice is the `liveSource`
 * field. We keep the original around so admins can re-run the enhancer
 * after we improve the prompt.
 *
 * Status lifecycle:
 *   draft     - uploaded, not yet enhanced/scored
 *   enhanced  - AI suggestions ran, awaiting admin decision
 *   published - admin accepted; only published templates are user-visible
 *   archived  - hidden from users but kept for history
 *
 * ATS gate: `published` is only allowed once `atsScore >= MIN_PUBLISH_SCORE`
 * (60 by default). Enforcement lives in the admin controller; the model
 * keeps both `atsScore` and `atsScoreSource` so we can show users an honest
 * "scored by AI" vs "scored by heuristic" badge.
 */

export const MIN_PUBLISH_ATS_SCORE = 60;

export type ResumeTemplateStatus = 'draft' | 'enhanced' | 'published' | 'archived';
export type LiveSource = 'original' | 'enhanced';

export interface IResumeTemplate extends Document {
  _id: mongoose.Types.ObjectId;
  slug: string;
  name: string;
  description: string;
  category: string;
  htmlOriginal: string;
  htmlEnhanced: string | null;
  liveSource: LiveSource;
  previewImageUrl: string | null;
  atsScore: number;
  atsScoreSource: 'ai' | 'heuristic' | 'unscored';
  atsNotes: string[];
  status: ResumeTemplateStatus;
  isPremium: boolean;
  sortOrder: number;
  createdBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const templateSchema = new Schema<IResumeTemplate>(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: '', maxlength: 400 },
    category: { type: String, default: 'general', trim: true, lowercase: true },
    htmlOriginal: { type: String, required: true },
    htmlEnhanced: { type: String, default: null },
    liveSource: {
      type: String,
      enum: ['original', 'enhanced'],
      default: 'original',
    },
    previewImageUrl: { type: String, default: null },
    atsScore: { type: Number, default: 0, min: 0, max: 100 },
    atsScoreSource: {
      type: String,
      enum: ['ai', 'heuristic', 'unscored'],
      default: 'unscored',
    },
    atsNotes: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['draft', 'enhanced', 'published', 'archived'],
      default: 'draft',
      index: true,
    },
    isPremium: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 100 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

templateSchema.index({ status: 1, sortOrder: 1 });
templateSchema.index({ category: 1, status: 1 });

export const ResumeTemplate: Model<IResumeTemplate> =
  mongoose.models.ResumeTemplate ||
  mongoose.model<IResumeTemplate>('ResumeTemplate', templateSchema);
