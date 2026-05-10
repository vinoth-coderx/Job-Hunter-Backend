import { Router } from 'express';
import {
  generateCoverLetterEndpoint,
  profileOptimizerEndpoint,
  skillGapEndpoint,
  quotaStatusEndpoint,
  jobInsightEndpoint,
  chatSendEndpoint,
  chatHistoryEndpoint,
  chatClearEndpoint,
  forYouEndpoint,
  fieldSuggestEndpoint,
  fieldSuggestSchema,
  coverLetterSchema,
  skillGapSchema,
  jobInsightSchema,
  chatSchema,
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

router.get('/quota', quotaStatusEndpoint);
router.post('/job-insight', validate(jobInsightSchema), jobInsightEndpoint);

router.post('/chat', validate(chatSchema), chatSendEndpoint);
router.get('/chat', chatHistoryEndpoint);
router.delete('/chat', chatClearEndpoint);

router.get('/for-you', forYouEndpoint);
router.post(
  '/profile-field-suggest',
  validate(fieldSuggestSchema),
  fieldSuggestEndpoint,
);

export default router;
