import { Router } from 'express';
import {
  getSettings,
  updateSettings,
  pauseAutoApply,
  resumeAutoApply,
  runNow,
  getPreview,
  approveJobs,
  listLogs,
  todaySummary,
  updateSettingsSchema,
  pauseSchema,
  approveSchema,
} from '../controllers/autoApply.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
router.use(authenticate);

router.get('/settings', getSettings);
router.put('/settings', validate(updateSettingsSchema), updateSettings);
router.post('/pause', validate(pauseSchema), pauseAutoApply);
router.post('/resume', resumeAutoApply);
router.post('/run-now', runNow);
router.get('/preview', getPreview);
router.post('/approve', validate(approveSchema), approveJobs);
router.get('/logs', listLogs);
router.get('/logs/today', todaySummary);

export default router;
