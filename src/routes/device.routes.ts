import { Router } from 'express';
import {
  registerDeviceToken,
  unregisterDeviceToken,
  registerTokenSchema,
} from '../controllers/device.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();

router.use(authenticate);

router.post('/token', validate(registerTokenSchema), registerDeviceToken);
router.delete('/token/:token', unregisterDeviceToken);

export default router;
