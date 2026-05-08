import axios from 'axios';
import crypto from 'crypto';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';

/**
 * Razorpay integration. We deliberately don't pull the official `razorpay`
 * npm package — its surface is small enough that hitting the REST API
 * directly with axios is clearer and avoids the dependency.
 *
 * Order creation:    POST /v1/orders     (Basic auth: key_id:key_secret)
 * Signature verify:  HMAC-SHA256(orderId|paymentId, key_secret) === signature
 * Webhook verify:    HMAC-SHA256(rawBody, webhook_secret)         === signature
 */

const BASE = 'https://api.razorpay.com';

const requireKeys = (): { keyId: string; keySecret: string } => {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw ApiError.internal('Razorpay keys not configured (set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET)');
  }
  return { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET };
};

export interface RazorpayOrder {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt?: string;
  status: 'created' | 'attempted' | 'paid';
  created_at: number;
}

export const createRazorpayOrder = async (params: {
  amountPaise: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrder> => {
  const { keyId, keySecret } = requireKeys();
  const { amountPaise, currency = 'INR', receipt, notes } = params;

  if (amountPaise < 100) {
    // Razorpay rejects amounts below 100 paise (₹1).
    throw ApiError.badRequest('Amount must be at least 100 paise (₹1)');
  }

  try {
    const res = await axios.post<RazorpayOrder>(
      `${BASE}/v1/orders`,
      {
        amount: amountPaise,
        currency,
        receipt,
        notes,
        // payment_capture: 1 — captured automatically on success.
        payment_capture: 1,
      },
      {
        auth: { username: keyId, password: keySecret },
        timeout: 12_000,
      },
    );
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const detail = err.response?.data;
      logger.error('Razorpay createOrder failed', detail ?? err.message);
      throw ApiError.badRequest(
        typeof detail === 'object' && detail !== null && 'error' in detail
          ? `Razorpay: ${JSON.stringify(detail.error)}`
          : 'Razorpay order creation failed',
      );
    }
    throw err;
  }
};

/**
 * Confirms that a payment really came from Razorpay using their HMAC
 * scheme. Never trust client-supplied success without this check.
 */
export const verifyPaymentSignature = (params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean => {
  const { keySecret } = requireKeys();
  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${params.orderId}|${params.paymentId}`)
    .digest('hex');
  // Constant-time compare to avoid timing attacks.
  if (expected.length !== params.signature.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(params.signature, 'hex'),
  );
};

/**
 * Verify a Razorpay webhook delivery using the configured webhook secret.
 * Razorpay sends `x-razorpay-signature` = HMAC-SHA256(rawBody, webhookSecret).
 */
export const verifyWebhookSignature = (params: {
  rawBody: string;
  signature: string;
  webhookSecret: string;
}): boolean => {
  const expected = crypto
    .createHmac('sha256', params.webhookSecret)
    .update(params.rawBody)
    .digest('hex');
  if (expected.length !== params.signature.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(params.signature, 'hex'),
  );
};
