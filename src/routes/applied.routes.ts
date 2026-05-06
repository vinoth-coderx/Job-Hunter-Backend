import { Router } from 'express';
import {
  applyToJob,
  listApplied,
  updateApplied,
  deleteApplied,
  appliedStats,
  applySchema,
  updateAppliedSchema,
} from '../controllers/applied.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();

router.use(authenticate);

router.get('/', listApplied);
router.get('/stats', appliedStats);
router.post('/', validate(applySchema), applyToJob);
router.patch('/:id', validate(updateAppliedSchema), updateApplied);
router.delete('/:id', deleteApplied);

export default router;
