import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  createReport,
  createReportSchema,
  listMyReports,
} from '../controllers/reports.controller';

const router = Router();

router.use(authenticate);
router.post('/', validate(createReportSchema), createReport);
router.get('/mine', listMyReports);

export default router;
