import { Router } from 'express';
import {
  scheduleInterview,
  listHirerInterviews,
  getInterview,
  updateInterview,
  cancelInterview,
  submitFeedback,
  listSeekerInterviews,
  confirmInterview,
  scheduleInterviewSchema,
  updateInterviewSchema,
  submitFeedbackSchema,
} from '../controllers/interview.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

// Hirer
router.post('/hirer', validate(scheduleInterviewSchema), scheduleInterview);
router.get('/hirer', listHirerInterviews);
router.put('/hirer/:id', validate(updateInterviewSchema), updateInterview);
router.delete('/hirer/:id', cancelInterview);
router.post('/hirer/:id/feedback', validate(submitFeedbackSchema), submitFeedback);

// Seeker
router.get('/seeker', listSeekerInterviews);
router.put('/seeker/:id/confirm', confirmInterview);

// Either party
router.get('/:id', getInterview);

export default router;
