import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
  listPublicTemplates,
  getPublicTemplate,
  getTemplateQuota,
  downloadTemplate,
  previewSampleTemplate,
} from '../controllers/resumeTemplates.controller';

const router = Router();

// Templates are user-private content (catalog) and we want auth so we
// can surface premium-gated templates correctly per user later. Listing
// is fine without it but we keep the gate for consistency.
router.use(authenticate);

router.get('/', listPublicTemplates);
router.get('/quota', getTemplateQuota);
router.get('/:slug', getPublicTemplate);
// Sample PDF — no quota, returns the template with placeholder values
// pre-filled so the seeker can preview before applying their own data.
router.get('/:slug/preview-sample.pdf', previewSampleTemplate);
router.post('/:slug/download', downloadTemplate);

export default router;
