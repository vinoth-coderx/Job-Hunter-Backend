import axios from 'axios';
import crypto from 'crypto';
import { env } from '../config/env';
import { getAppConfig } from './config/config.service';
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

export type RazorpayMode = 'test' | 'live';

/**
 * Resolve which Razorpay credential set to use. The hard rule:
 *   - In `NODE_ENV=production`, we ALWAYS use live, regardless of what the
 *     client asks for. A release-build user cannot self-downgrade into test
 *     mode by spoofing a request — debug-mode bypass only works against a
 *     non-production backend (local/staging).
 *   - Otherwise (dev/staging), honor the requested mode if its keys are
 *     configured; fall back to live with a warning if not.
 */
export const resolveRazorpayMode = (requested: RazorpayMode | undefined): RazorpayMode => {
  if (env.NODE_ENV === 'production') return 'live';
  if (
    requested === 'test' &&
    getAppConfig('RAZORPAY_TEST_KEY_ID') &&
    getAppConfig('RAZORPAY_TEST_KEY_SECRET')
  ) {
    return 'test';
  }
  return 'live';
};

const requireKeys = (mode: RazorpayMode): { keyId: string; keySecret: string } => {
  const keyId = getAppConfig(mode === 'test' ? 'RAZORPAY_TEST_KEY_ID' : 'RAZORPAY_KEY_ID');
  const keySecret = getAppConfig(
    mode === 'test' ? 'RAZORPAY_TEST_KEY_SECRET' : 'RAZORPAY_KEY_SECRET',
  );
  if (!keyId || !keySecret) {
    throw ApiError.internal(
      `Razorpay ${mode} keys not configured (set RAZORPAY_${mode === 'test' ? 'TEST_' : ''}KEY_ID, RAZORPAY_${mode === 'test' ? 'TEST_' : ''}KEY_SECRET in admin panel or .env)`,
    );
  }
  return { keyId, keySecret };
};

export const getRazorpayKeyId = (mode: RazorpayMode): string => requireKeys(mode).keyId;

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
  mode: RazorpayMode;
}): Promise<RazorpayOrder> => {
  const { keyId, keySecret } = requireKeys(params.mode);
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
 * Fetch an order from Razorpay. Used to re-derive trusted tier/userId/amount
 * from server-set `notes` rather than trusting the client.
 */
export const fetchRazorpayOrder = async (
  orderId: string,
  mode: RazorpayMode,
): Promise<RazorpayOrder & { notes?: Record<string, string> }> => {
  const { keyId, keySecret } = requireKeys(mode);
  try {
    const res = await axios.get(`${BASE}/v1/orders/${orderId}`, {
      auth: { username: keyId, password: keySecret },
      timeout: 12_000,
    });
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      logger.error('Razorpay fetchOrder failed', err.response?.data ?? err.message);
      throw ApiError.badRequest('Could not fetch Razorpay order');
    }
    throw err;
  }
};

export interface RazorpayPayment {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  order_id: string;
  method: string;
  captured: boolean;
  email?: string;
  contact?: string;
  notes?: Record<string, string>;
  created_at: number;
}

/**
 * Fetch a payment from Razorpay. Used inside the webhook handler to
 * authoritatively check status === 'captured' before activating a sub.
 */
export const fetchRazorpayPayment = async (
  paymentId: string,
  mode: RazorpayMode,
): Promise<RazorpayPayment> => {
  const { keyId, keySecret } = requireKeys(mode);
  try {
    const res = await axios.get<RazorpayPayment>(`${BASE}/v1/payments/${paymentId}`, {
      auth: { username: keyId, password: keySecret },
      timeout: 12_000,
    });
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      logger.error('Razorpay fetchPayment failed', err.response?.data ?? err.message);
      throw ApiError.badRequest('Could not fetch Razorpay payment');
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
  mode: RazorpayMode;
}): boolean => {
  const { keySecret } = requireKeys(params.mode);
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
