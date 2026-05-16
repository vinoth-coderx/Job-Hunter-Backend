import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  submitGst,
  submitGstSchema,
  submitDomainEmail,
  submitDomainEmailSchema,
  confirmDomainEmail,
  confirmDomainEmailSchema,
  submitWebsite,
  submitWebsiteSchema,
  submitLinkedin,
  submitLinkedinSchema,
  myVerificationStatus,
} from '../controllers/verification.controller';

const router = Router();

router.use(authenticate);

router.get('/status', myVerificationStatus);
router.post('/gst', validate(submitGstSchema), submitGst);
router.post('/domain-email', validate(submitDomainEmailSchema), submitDomainEmail);
router.post('/domain-email/confirm', validate(confirmDomainEmailSchema), confirmDomainEmail);
router.post('/website', validate(submitWebsiteSchema), submitWebsite);
router.post('/linkedin', validate(submitLinkedinSchema), submitLinkedin);

export default router;
