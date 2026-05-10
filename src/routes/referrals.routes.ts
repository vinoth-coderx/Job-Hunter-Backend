import { Router } from 'express';
import {
  getMyReferralCode,
  claimReferral,
  claimReferralSchema,
} from '../controllers/referrals.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

router.get('/code', getMyReferralCode);
router.post('/claim', validate(claimReferralSchema), claimReferral);

export default router;
