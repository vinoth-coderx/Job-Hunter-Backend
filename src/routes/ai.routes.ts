import { Router } from 'express';
import {
  generateCoverLetterEndpoint,
  profileOptimizerEndpoint,
  skillGapEndpoint,
  coverLetterSchema,
  skillGapSchema,
} from '../controllers/ai.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

router.post(
  '/cover-letter',
  validate(coverLetterSchema),
  generateCoverLetterEndpoint,
);

router.get('/profile-optimizer', profileOptimizerEndpoint);
router.post('/skill-gap', validate(skillGapSchema), skillGapEndpoint);

export default router;
