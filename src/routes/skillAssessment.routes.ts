import { Router } from 'express';
import {
  startAssessment,
  submitAssessment,
  listMyAssessments,
  getAssessment,
  startAssessmentSchema,
  submitAssessmentSchema,
} from '../controllers/skillAssessment.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

router.get('/', listMyAssessments);
router.post('/start', validate(startAssessmentSchema), startAssessment);
router.get('/:id', getAssessment);
router.post('/:id/submit', validate(submitAssessmentSchema), submitAssessment);

export default router;
