import { Router } from 'express';
import {
  listPlans,
  currentSubscription,
  subscribe,
  cancelSubscription,
  subscriptionHistory,
  subscribeSchema,
} from '../controllers/subscription.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();

router.get('/plans', listPlans);

router.use(authenticate);
router.get('/current', currentSubscription);
router.get('/history', subscriptionHistory);
router.post('/subscribe', validate(subscribeSchema), subscribe);
router.post('/cancel', cancelSubscription);

export default router;
