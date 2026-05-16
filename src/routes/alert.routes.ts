import { Router } from 'express';
import {
  createAlert,
  listAlerts,
  updateAlert,
  deleteAlert,
  createAlertSchema,
  updateAlertSchema,
  suggestAlertNamesEndpoint,
  suggestAlertNameSchema,
} from '../controllers/alert.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();

router.use(authenticate);

router.get('/', listAlerts);
router.post('/', validate(createAlertSchema), createAlert);
router.post(
  '/suggest-name',
  validate(suggestAlertNameSchema),
  suggestAlertNamesEndpoint,
);
router.patch('/:id', validate(updateAlertSchema), updateAlert);
router.delete('/:id', deleteAlert);

export default router;
