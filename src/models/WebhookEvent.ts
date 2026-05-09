import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Dedupe table for incoming Razorpay webhook deliveries. Razorpay retries
 * failed deliveries (and sometimes re-fires successful ones), so the same
 * `x-razorpay-event-id` may arrive more than once. Inserting first and
 * relying on the unique index makes processing exactly-once even under a
 * race between two concurrent webhook deliveries.
 *
 * The `processedAt` TTL (90 days) auto-prunes the table — long enough to
 * cover any reasonable retry window, short enough to keep the collection
 * small.
 */
export interface IWebhookEvent extends Document {
  eventId: string;
  event: string;
  processedAt: Date;
}

const webhookEventSchema = new Schema<IWebhookEvent>(
  {
    eventId: { type: String, required: true, unique: true },
    event: { type: String, required: true },
    processedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
  },
  { versionKey: false },
);

export const WebhookEvent: Model<IWebhookEvent> = mongoose.model<IWebhookEvent>(
  'WebhookEvent',
  webhookEventSchema,
);
