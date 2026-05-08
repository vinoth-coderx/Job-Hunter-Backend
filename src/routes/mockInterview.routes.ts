import { Router } from 'express';
import {
  startMockInterview,
  answerMockInterview,
  finishMockInterview,
  listMockInterviews,
  getMockInterview,
  startMockSchema,
  answerMockSchema,
} from '../controllers/mockInterview.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

router.get('/', listMockInterviews);
router.post('/start', validate(startMockSchema), startMockInterview);
router.get('/:id', getMockInterview);
router.post('/:id/answer', validate(answerMockSchema), answerMockInterview);
router.post('/:id/finish', finishMockInterview);

export default router;
