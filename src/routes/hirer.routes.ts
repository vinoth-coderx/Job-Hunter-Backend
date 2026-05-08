import { Router } from 'express';
import {
  getMyHirerProfile,
  createHirerProfile,
  updateHirerProfile,
  uploadHirerLogo,
  getHirerLogo,
  uploadOfficePhotos as uploadOfficePhotosHandler,
  getOfficePhoto,
  deleteOfficePhoto,
  getPublicCompanyProfile,
  getHirerStats,
  createHirerProfileSchema,
  updateHirerProfileSchema,
} from '../controllers/hirer.controller';
import {
  createJob,
  listMyJobs,
  getMyJob,
  updateJob,
  updateJobStatus,
  deleteJob,
  getJobAnalytics,
  createJobSchema,
  updateJobSchema,
  listMyJobsSchema,
  updateStatusSchema,
} from '../controllers/hirerJob.controller';
import {
  listJobApplicants,
  listAllApplicants,
  getApplicantDetail,
  updateApplicantStatus,
  bulkUpdateApplicants,
  updateHirerNotes,
  getJobKanban,
  listApplicantsSchema,
  updateApplicantStatusSchema,
  bulkUpdateApplicantsSchema,
  updateHirerNotesSchema,
} from '../controllers/hirerApplicants.controller';
import { authenticate, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uploadCompanyLogo, uploadOfficePhotos } from '../middleware/upload';
import { getHirerAnalytics } from '../controllers/hirerAnalytics.controller';

const router = Router();

// Public — anyone can view a company profile by id (logos served publicly).
router.get('/profile/logo/:id/:filename', getHirerLogo);
router.get('/profile/photo/:id/:filename', getOfficePhoto);
router.get('/profile/public/:id', optionalAuth, getPublicCompanyProfile);

// Authenticated — current user's hirer profile.
router.get('/profile', authenticate, getMyHirerProfile);
router.post('/profile', authenticate, validate(createHirerProfileSchema), createHirerProfile);
router.put('/profile', authenticate, validate(updateHirerProfileSchema), updateHirerProfile);

router.post('/profile/logo', authenticate, uploadCompanyLogo, uploadHirerLogo);
router.post('/profile/photos', authenticate, uploadOfficePhotos, uploadOfficePhotosHandler);
router.delete('/profile/photos/:filename', authenticate, deleteOfficePhoto);

router.get('/stats', authenticate, getHirerStats);
router.get('/analytics', authenticate, getHirerAnalytics);

// Native job CRUD
router.post('/jobs', authenticate, validate(createJobSchema), createJob);
router.get('/jobs', authenticate, validate(listMyJobsSchema), listMyJobs);
router.get('/jobs/:id', authenticate, getMyJob);
router.put('/jobs/:id', authenticate, validate(updateJobSchema), updateJob);
router.put('/jobs/:id/status', authenticate, validate(updateStatusSchema), updateJobStatus);
router.delete('/jobs/:id', authenticate, deleteJob);
router.get('/jobs/:id/analytics', authenticate, getJobAnalytics);

// Applicants
router.get(
  '/jobs/:jobId/applicants',
  authenticate,
  validate(listApplicantsSchema),
  listJobApplicants,
);
router.get(
  '/applicants',
  authenticate,
  validate(listApplicantsSchema),
  listAllApplicants,
);
router.get('/jobs/:jobId/kanban', authenticate, getJobKanban);
router.get('/applicants/:id', authenticate, getApplicantDetail);
router.put(
  '/applicants/:id/status',
  authenticate,
  validate(updateApplicantStatusSchema),
  updateApplicantStatus,
);
router.put(
  '/applicants/:id/notes',
  authenticate,
  validate(updateHirerNotesSchema),
  updateHirerNotes,
);
router.post(
  '/applicants/bulk-action',
  authenticate,
  validate(bulkUpdateApplicantsSchema),
  bulkUpdateApplicants,
);

export default router;
