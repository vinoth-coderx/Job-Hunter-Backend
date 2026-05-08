import { Router } from 'express';
import {
  listBadges,
  checkInStreak,
  getStreak,
} from '../controllers/gamification.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/badges', listBadges);
router.get('/streak', getStreak);
router.post('/streak/checkin', checkInStreak);

export default router;
