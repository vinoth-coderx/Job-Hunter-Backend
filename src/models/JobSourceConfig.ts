import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Admin-managed catalog of scrapers the backend orchestrates.
 *
 * Replaces the hardcoded `KNOWN_SCRAPERS` array in utils/scraperTracker
 * so admins can: (a) toggle a source ON/OFF without redeploying, and
 * (b) register new "generic REST" sources with field-mapping configs
 * that drive the upcoming `GenericApiScraper`.
 *
 * The 5 historical scrapers (adzuna, serpapi, rapidapi,
 * arbeitnow, puppeteer) remain `type: "builtin"` — their fetch logic
 * is in code (services/scrapers/*) and isn't editable from the admin.
 * Only `enabled`, `queries`, `locations` and `notes` matter for them.
 *
 * Generic sources (`type: "generic"`) are fully driven by the
 * `generic` sub-document and have no code-side counterpart.
 */
export type JobSourceType = 'builtin' | 'generic';
export type JobSourcePricing = 'Free' | 'Freemium' | 'Paid';

export interface IGenericSourceConfig {
  endpointUrl: string;
  httpMethod: 'GET' | 'POST';
  authHeader?: string;
  /** AppConfig key whose value gets injected into authHeader. */
  authValueConfigKey?: string;
  /** Prefix prepended to the auth value (e.g. "Bearer "). */
  authValuePrefix?: string;
  /** Static request headers (Content-Type, Accept etc.). */
  requestHeaders?: Record<string, string>;
  /** Template body for POST. {query} {location} {page} are interpolated. */
  requestBody?: string;
  /** Dotted JSON path to the array of jobs in the response. */
  responseRootPath: string;
  /** Maps response fields → ScrapedJob fields (all dotted paths). */
  fieldMap: {
    title: string;
    company: string;
    location?: string;
    description?: string;
    url: string;
    externalId: string;
    salary?: string;
    type?: string;
    postedAt?: string;
  };
  /** Query parameter name used for pagination (?page=N). */
  pageParam?: string;
  pageCount: number;
  /** Sleep this many ms between calls; 0 = no throttle. */
  rateLimitMs: number;
}

export interface IJobSourceConfig extends Document {
  _id: mongoose.Types.ObjectId;
  source: string;
  label: string;
  category: string;
  pricing: JobSourcePricing;
  type: JobSourceType;
  enabled: boolean;
  /** AppConfig keys this source needs (builtin only). */
  keyConfigKeys: string[];
  /** Per-source query override; empty = use pipeline defaults. */
  queries: string[];
  /** Per-source location override; empty = use pipeline defaults. */
  locations: string[];
  /** Generic-only fields (required iff type === "generic"). */
  generic?: IGenericSourceConfig;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const genericSchema = new Schema<IGenericSourceConfig>(
  {
    endpointUrl: { type: String, required: true },
    httpMethod: { type: String, enum: ['GET', 'POST'], default: 'GET' },
    authHeader: String,
    authValueConfigKey: String,
    authValuePrefix: String,
    requestHeaders: { type: Schema.Types.Mixed, default: {} },
    requestBody: String,
    responseRootPath: { type: String, required: true },
    fieldMap: {
      title: { type: String, required: true },
      company: { type: String, required: true },
      location: String,
      description: String,
      url: { type: String, required: true },
      externalId: { type: String, required: true },
      salary: String,
      type: String,
      postedAt: String,
    },
    pageParam: String,
    pageCount: { type: Number, default: 1, min: 1, max: 10 },
    rateLimitMs: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const jobSourceConfigSchema = new Schema<IJobSourceConfig>(
  {
    source: { type: String, required: true, unique: true, index: true },
    label: { type: String, required: true },
    category: { type: String, required: true },
    pricing: {
      type: String,
      enum: ['Free', 'Freemium', 'Paid'],
      default: 'Free',
    },
    type: {
      type: String,
      enum: ['builtin', 'generic'],
      required: true,
    },
    enabled: { type: Boolean, default: true },
    keyConfigKeys: { type: [String], default: [] },
    queries: { type: [String], default: [] },
    locations: { type: [String], default: [] },
    generic: { type: genericSchema, required: false },
    notes: String,
  },
  { timestamps: true },
);

export const JobSourceConfig: Model<IJobSourceConfig> =
  mongoose.models.JobSourceConfig ||
  mongoose.model<IJobSourceConfig>('JobSourceConfig', jobSourceConfigSchema);
