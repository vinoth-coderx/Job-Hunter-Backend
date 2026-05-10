import { Router } from 'express';
import express from 'express';
import {
  listPlans,
  currentSubscription,
  subscribe,
  cancelSubscription,
  subscriptionHistory,
  subscribeSchema,
  razorpayCreateOrder,
  razorpayVerifyPayment,
  razorpayWebhook,
  createRazorpayOrderSchema,
  verifyRazorpayPaymentSchema,
  redeemWithCoins,
  redeemWithCoinsSchema,
} from '../controllers/subscription.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();

router.get('/plans', listPlans);

// Razorpay webhook — MUST receive the raw body so HMAC signature can
// be verified against the exact bytes Razorpay sent. Mounted before the
// authenticate gate (Razorpay servers won't carry our JWT).
router.post(
  '/razorpay/webhook',
  express.raw({ type: 'application/json' }),
  razorpayWebhook,
);

router.use(authenticate);
router.get('/current', currentSubscription);
router.get('/history', subscriptionHistory);
router.post('/subscribe', validate(subscribeSchema), subscribe);
router.post('/cancel', cancelSubscription);

router.post(
  '/razorpay/order',
  validate(createRazorpayOrderSchema),
  razorpayCreateOrder,
);
router.post(
  '/razorpay/verify',
  validate(verifyRazorpayPaymentSchema),
  razorpayVerifyPayment,
);

router.post(
  '/redeem-with-coins',
  validate(redeemWithCoinsSchema),
  redeemWithCoins,
);

export default router;
