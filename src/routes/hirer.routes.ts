import { Router } from 'express';
import {
  getMyHirerProfile,
  createHirerProfile,
  updateHirerProfile,
  uploadHirerLogo,
  uploadOfficePhotos as uploadOfficePhotosHandler,
  deleteOfficePhoto,
  getPublicCompanyProfile,
  getHirerStats,
  createHirerProfileSchema,
  updateHirerProfileSchema,
  generateCompanyDescriptionEndpoint,
  generateCompanyDescriptionSchema,
} from '../controllers/hirer.controller';
import {
  createJob,
  listMyJobs,
  getMyJob,
  updateJob,
  updateJobStatus,
  deleteJob,
  getJobAnalytics,
  generateJdEndpoint,
  createJobSchema,
  updateJobSchema,
  listMyJobsSchema,
  updateStatusSchema,
  generateJdSchema,
  submitModerationAppeal,
  submitModerationAppealSchema,
  extractSkillsEndpoint,
  extractSkillsSchema,
  generateScreeningQuestionsEndpoint,
  generateScreeningQuestionsSchema,
  polishJdEndpoint,
  polishJdSchema,
} from '../controllers/hirerJob.controller';
import {
  listJobApplicants,
  listAllApplicants,
  getApplicantDetail,
  downloadApplicantResume,
  updateApplicantStatus,
  bulkUpdateApplicants,
  updateHirerNotes,
  getJobKanban,
  listApplicantsSchema,
  updateApplicantStatusSchema,
  bulkUpdateApplicantsSchema,
  updateHirerNotesSchema,
  rankJobApplicants,
  rankApplicantsSchema,
  suggestJobCandidates,
  candidateSuggestionsSchema,
  draftCandidateOutreach,
  getApplicantResumeTldr,
} from '../controllers/hirerApplicants.controller';
import { authenticate, optionalAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { uploadCompanyLogo, uploadOfficePhotos } from '../middleware/upload';
import {
  getHirerAnalytics,
  getHirerDigestEndpoint,
  getHirerAttentionEndpoint,
} from '../controllers/hirerAnalytics.controller';

const router = Router();

// Public — anyone can view a company profile by id. Logos / photos
// are served directly from Cloudinary now, so no file-proxy routes here.
router.get('/profile/public/:id', optionalAuth, getPublicCompanyProfile);

// Authenticated — current user's hirer profile.
router.get('/profile', authenticate, getMyHirerProfile);
router.post('/profile', authenticate, validate(createHirerProfileSchema), createHirerProfile);
router.put('/profile', authenticate, validate(updateHirerProfileSchema), updateHirerProfile);

// AI: draft a 2-3 paragraph "About" blurb for the hirer profile.
router.post(
  '/profile/generate-description',
  authenticate,
  validate(generateCompanyDescriptionSchema),
  generateCompanyDescriptionEndpoint,
);

router.post('/profile/logo', authenticate, uploadCompanyLogo, uploadHirerLogo);
router.post('/profile/photos', authenticate, uploadOfficePhotos, uploadOfficePhotosHandler);
router.delete('/profile/photos/:filename', authenticate, deleteOfficePhoto);

router.get('/stats', authenticate, getHirerStats);
router.get('/analytics', authenticate, getHirerAnalytics);
router.get('/digest', authenticate, getHirerDigestEndpoint);
router.get('/attention', authenticate, getHirerAttentionEndpoint);

// AI: generate JD draft from role + keywords
router.post('/jobs/generate', authenticate, validate(generateJdSchema), generateJdEndpoint);

// AI: extract structured skill list from a JD draft (Groq, no quota cost)
router.post(
  '/jobs/extract-skills',
  authenticate,
  validate(extractSkillsSchema),
  extractSkillsEndpoint,
);

// AI: generate 3-5 screening questions tailored to the JD draft
router.post(
  '/jobs/screening-questions',
  authenticate,
  validate(generateScreeningQuestionsSchema),
  generateScreeningQuestionsEndpoint,
);

// AI: polish a JD draft for clarity / structure / inclusivity (no new
// requirements introduced — see jdPolish.service for guardrails)
router.post(
  '/jobs/polish',
  authenticate,
  validate(polishJdSchema),
  polishJdEndpoint,
);

// Native job CRUD
router.post('/jobs', authenticate, validate(createJobSchema), createJob);
router.get('/jobs', authenticate, validate(listMyJobsSchema), listMyJobs);
router.get('/jobs/:id', authenticate, getMyJob);
router.put('/jobs/:id', authenticate, validate(updateJobSchema), updateJob);
router.put('/jobs/:id/status', authenticate, validate(updateStatusSchema), updateJobStatus);
router.delete('/jobs/:id', authenticate, deleteJob);
router.get('/jobs/:id/analytics', authenticate, getJobAnalytics);
router.post(
  '/jobs/:id/moderation/appeal',
  authenticate,
  validate(submitModerationAppealSchema),
  submitModerationAppeal,
);

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
router.post(
  '/jobs/:jobId/applicants/rank',
  authenticate,
  validate(rankApplicantsSchema),
  rankJobApplicants,
);
router.post(
  '/jobs/:jobId/candidate-suggestions',
  authenticate,
  validate(candidateSuggestionsSchema),
  suggestJobCandidates,
);
router.post(
  '/jobs/:jobId/candidates/:userId/outreach',
  authenticate,
  draftCandidateOutreach,
);
router.get('/jobs/:jobId/kanban', authenticate, getJobKanban);
router.get('/applicants/:id', authenticate, getApplicantDetail);
router.get('/applicants/:id/resume', authenticate, downloadApplicantResume);
router.get(
  '/applicants/:id/resume-tldr',
  authenticate,
  getApplicantResumeTldr,
);
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
