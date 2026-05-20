import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminGuard';

import {
  listConfig,
  upsertConfig,
  removeConfig,
  probeConfig,
  listConfigRegistry,
} from '../controllers/adminConfig.controller';

import {
  listUsers,
  userStats,
  getUser,
  getUserTrust,
  updateUser,
  banUser,
  unbanUser,
} from '../controllers/adminUsers.controller';

import {
  getCronsOverview,
  setCronMaster,
  setCronSchedule,
  runCronNow,
} from '../controllers/adminCrons.controller';

import {
  createJobSource,
  deleteJobSource,
  getJobSources,
  runJobFetch,
  toggleJobSource,
  updateJobSource,
} from '../controllers/adminJobSources.controller';

import { getSubscriptionsOverview } from '../controllers/adminSubscriptions.controller';

import {
  listAdminPlans,
  createPlan,
  updatePlan,
  togglePlan,
  deletePlan,
  createPlanSchema,
  updatePlanSchema,
  togglePlanSchema,
} from '../controllers/adminSubscriptionPlans.controller';

import {
  listAdminTemplates,
  getAdminTemplate,
  createTemplate,
  updateTemplate,
  enhanceTemplateEndpoint,
  publishTemplate,
  archiveTemplate,
  deleteTemplate,
  createTemplateSchema,
  updateTemplateSchema,
  statusActionSchema,
} from '../controllers/adminResumeTemplates.controller';

import {
  listAiKeys,
  createAiKey,
  updateAiKey,
  toggleAiKey,
  deleteAiKey,
  testAiKey,
  syncAiKeysToAppConfig,
} from '../controllers/adminAiKeys.controller';

import { getAdminHealth } from '../controllers/adminHealth.controller';

import {
  aiAnalyticsOverview,
  aiAnalyticsSchema,
  updateCreditWeights,
  updateCreditWeightsSchema,
  aiCostForecastEndpoint,
  aiCostForecastSchema,
  aiFeedbackSamplesEndpoint,
  aiFeedbackSamplesSchema,
} from '../controllers/adminAiAnalytics.controller';

import {
  listModerationQueue,
  decideModeration,
  moderationDecisionSchema,
  listReports,
  resolveReport,
  resolveReportSchema,
  listAuditLogs,
  listSecurityEvents,
  acknowledgeSecurityEvent,
  bulkAckSecurityEvents,
  listVerificationQueue,
  reviewVerification,
  reviewVerificationSchema,
  reviewHirer,
  approveHirerSchema,
  listModerationAppeals,
  resolveModerationAppeal,
  resolveAppealSchema,
} from '../controllers/adminModeration.controller';
import { validate } from '../middleware/validate';

const router = Router();

// X-Runtime-Mode is read globally in app.ts so the auth lookup itself
// already runs against the correct cluster.

// Every endpoint requires a signed-in admin. authenticate populates
// req.user; requireAdmin verifies isAdmin from the freshest User doc.
router.use(authenticate, requireAdmin);

// --- Users ----------------------------------------------------------------
router.get('/users/stats', userStats);
router.get('/users', listUsers);
router.get('/users/:id', getUser);
router.get('/users/:id/trust', getUserTrust);
router.patch('/users/:id', updateUser);
router.post('/users/:id/ban', banUser);
router.post('/users/:id/unban', unbanUser);

// --- App Config -----------------------------------------------------------
router.get('/config', listConfig);
router.get('/config/registry', listConfigRegistry);
router.put('/config', upsertConfig);
router.delete('/config/:key', removeConfig);
router.get('/config/:key/probe', probeConfig);

// --- Crons ----------------------------------------------------------------
router.get('/crons', getCronsOverview);
router.patch('/crons/enabled', setCronMaster);
router.patch('/crons/:name/schedule', setCronSchedule);
router.post('/crons/:name/run', runCronNow);

// --- Jobs & Sources -------------------------------------------------------
router.get('/jobs/sources', getJobSources);
router.post('/jobs/sources', createJobSource);
router.post('/jobs/sources/run', runJobFetch);
router.patch('/jobs/sources/:source/toggle', toggleJobSource);
router.patch('/jobs/sources/:source', updateJobSource);
router.delete('/jobs/sources/:source', deleteJobSource);

// --- Subscriptions --------------------------------------------------------
router.get('/subscriptions/overview', getSubscriptionsOverview);
router.get('/subscriptions/plans', listAdminPlans);
router.post('/subscriptions/plans', validate(createPlanSchema), createPlan);
router.patch(
  '/subscriptions/plans/:tier',
  validate(updatePlanSchema),
  updatePlan,
);
router.patch(
  '/subscriptions/plans/:tier/toggle',
  validate(togglePlanSchema),
  togglePlan,
);
router.delete('/subscriptions/plans/:tier', deletePlan);

// --- Resume Templates -----------------------------------------------------
router.get('/resume-templates', listAdminTemplates);
router.get('/resume-templates/:slug', getAdminTemplate);
router.post(
  '/resume-templates',
  validate(createTemplateSchema),
  createTemplate,
);
router.patch(
  '/resume-templates/:slug',
  validate(updateTemplateSchema),
  updateTemplate,
);
router.post(
  '/resume-templates/:slug/enhance',
  validate(statusActionSchema),
  enhanceTemplateEndpoint,
);
router.post(
  '/resume-templates/:slug/publish',
  validate(statusActionSchema),
  publishTemplate,
);
router.post(
  '/resume-templates/:slug/archive',
  validate(statusActionSchema),
  archiveTemplate,
);
router.delete('/resume-templates/:slug', deleteTemplate);

// --- AI Analytics (per-feature/provider/user usage + cost dashboards) ----
router.get('/ai/analytics', validate(aiAnalyticsSchema), aiAnalyticsOverview);
router.get(
  '/ai/cost-forecast',
  validate(aiCostForecastSchema),
  aiCostForecastEndpoint,
);
router.get(
  '/ai/feedback/samples',
  validate(aiFeedbackSamplesSchema),
  aiFeedbackSamplesEndpoint,
);
router.put(
  '/ai/credit-weights',
  validate(updateCreditWeightsSchema),
  updateCreditWeights,
);

// --- AI Providers ---------------------------------------------------------
router.get('/ai/keys', listAiKeys);
router.post('/ai/keys', createAiKey);
// Force-resync every AiKey → AppConfig. Idempotent — safe to hit when
// the runtime says "AI disabled" but the /ai page shows valid rows.
// Returns a per-provider report so the operator can see *why* it was
// disabled (no rows / no active rows / synced but key invalid / etc.).
router.post('/ai/keys/sync', syncAiKeysToAppConfig);
router.patch('/ai/keys/:id/toggle', toggleAiKey);
router.post('/ai/keys/:id/test', testAiKey);
router.patch('/ai/keys/:id', updateAiKey);
router.delete('/ai/keys/:id', deleteAiKey);

// --- Health ---------------------------------------------------------------
router.get('/health', getAdminHealth);

// --- Moderation queue (native job listings flagged or queued) -------------
router.get('/moderation/jobs', listModerationQueue);
router.post(
  '/moderation/jobs/:id/decide',
  validate(moderationDecisionSchema),
  decideModeration,
);

// --- Moderation appeals (hirer-filed challenges to a rejection) ----------
router.get('/moderation/appeals', listModerationAppeals);
router.post(
  '/moderation/appeals/:id/decide',
  validate(resolveAppealSchema),
  resolveModerationAppeal,
);

// --- Reports (fake jobs / recruiters / messages) --------------------------
router.get('/reports', listReports);
router.post('/reports/:id/resolve', validate(resolveReportSchema), resolveReport);

// --- Audit logs -----------------------------------------------------------
router.get('/audit-logs', listAuditLogs);

// --- Security events ------------------------------------------------------
router.get('/security/events', listSecurityEvents);
router.post('/security/events/:id/ack', acknowledgeSecurityEvent);
router.post('/security/events/bulk-ack', bulkAckSecurityEvents);

// --- Verification queue ---------------------------------------------------
router.get('/verifications', listVerificationQueue);
router.post(
  '/verifications/:id/review',
  validate(reviewVerificationSchema),
  reviewVerification,
);

// --- Hirer approval -------------------------------------------------------
router.post('/hirers/:id/review', validate(approveHirerSchema), reviewHirer);

export default router;
