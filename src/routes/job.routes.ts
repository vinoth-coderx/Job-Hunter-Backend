import { Router } from 'express';
import {
  listJobs,
  listAllJobs,
  getJob,
  matchedJobs,
  triggerFetch,
  listJobsSchema,
} from '../controllers/job.controller';
import {
  listSavedJobs,
  listSavedJobIds,
  saveJob,
  unsaveJob,
} from '../controllers/savedJobs.controller';
import { recordJobView } from '../controllers/jobView.controller';
import { authenticate, authenticateOrGuest, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();

// Static segments must be declared before the `/:id` catch-all so Express
// doesn't route /matched, /all, /feed into getJob.
router.get('/', optionalAuth, validate(listJobsSchema), listJobs);
router.get('/feed', optionalAuth, validate(listJobsSchema), listJobs);
router.get('/all', optionalAuth, listAllJobs);
// Accepts both real users (personalised matches) and guests (degrades to
// public recent listings). Subscription gate is also relaxed for guests
// inside the controller — the gate only applies to real-user tiers.
router.get('/matched', authenticateOrGuest, matchedJobs);

// Saved jobs — declared before `/:id` for the same reason as above.
router.get('/saved', authenticate, listSavedJobs);
router.get('/saved/ids', authenticate, listSavedJobIds);

router.post('/admin/fetch', authenticate, triggerFetch);

router.post('/:id/save', authenticate, saveJob);
router.delete('/:id/save', authenticate, unsaveJob);
router.post('/:id/view', optionalAuth, recordJobView);
router.get('/:id', optionalAuth, getJob);

export default router;
