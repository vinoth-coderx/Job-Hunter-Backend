import { Router } from 'express';
import {
  createAlert,
  listAlerts,
  updateAlert,
  deleteAlert,
  createAlertSchema,
  updateAlertSchema,
} from '../controllers/alert.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();

router.use(authenticate);

router.get('/', listAlerts);
router.post('/', validate(createAlertSchema), createAlert);
router.patch('/:id', validate(updateAlertSchema), updateAlert);
router.delete('/:id', deleteAlert);

export default router;
