import { Router } from 'express';
import {
  listJobs,
  listAllJobs,
  getJob,
  matchedJobs,
  triggerFetch,
  warmCache,
  clearCache,
  listJobsSchema,
} from '../controllers/job.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { requireSubscription } from '../middleware/subscription';

const router = Router();

router.use(authenticate);

router.get('/', requireSubscription('free'), validate(listJobsSchema), listJobs);
router.get('/all', requireSubscription('free'), listAllJobs);
router.get('/matched', requireSubscription('free'), matchedJobs);
router.get('/feed', requireSubscription('free'), matchedJobs);
router.post('/admin/fetch', triggerFetch);
router.post('/admin/cache/warm', warmCache);
router.post('/admin/cache/clear', clearCache);
router.get('/:id', getJob);

export default router;
