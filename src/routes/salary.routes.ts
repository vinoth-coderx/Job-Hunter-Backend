import { Router } from 'express';
import {
  getInsights,
  submitSalary,
  compareSalary,
  insightsQuerySchema,
  submitSchema,
  compareSchema,
} from '../controllers/salary.controller';
import { authenticate, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();

// Read is open to anyone — guests can browse insights too.
router.get('/', optionalAuth, validate(insightsQuerySchema), getInsights);

// Submit + compare require an authenticated user.
router.post('/submit', authenticate, validate(submitSchema), submitSalary);
router.post('/compare', authenticate, validate(compareSchema), compareSalary);

export default router;
