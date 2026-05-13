import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminGuard';

import {
  listConfig,
  upsertConfig,
  removeConfig,
  probeConfig,
} from '../controllers/adminConfig.controller';

import {
  listUsers,
  userStats,
  getUser,
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
  listAiKeys,
  createAiKey,
  updateAiKey,
  toggleAiKey,
  deleteAiKey,
  testAiKey,
} from '../controllers/adminAiKeys.controller';

import { getAdminHealth } from '../controllers/adminHealth.controller';

const router = Router();

// Every endpoint requires a signed-in admin. authenticate populates
// req.user; requireAdmin verifies isAdmin from the freshest User doc.
router.use(authenticate, requireAdmin);

// --- Users ----------------------------------------------------------------
router.get('/users/stats', userStats);
router.get('/users', listUsers);
router.get('/users/:id', getUser);
router.patch('/users/:id', updateUser);
router.post('/users/:id/ban', banUser);
router.post('/users/:id/unban', unbanUser);

// --- App Config -----------------------------------------------------------
router.get('/config', listConfig);
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

// --- AI Providers ---------------------------------------------------------
router.get('/ai/keys', listAiKeys);
router.post('/ai/keys', createAiKey);
router.patch('/ai/keys/:id/toggle', toggleAiKey);
router.post('/ai/keys/:id/test', testAiKey);
router.patch('/ai/keys/:id', updateAiKey);
router.delete('/ai/keys/:id', deleteAiKey);

// --- Health ---------------------------------------------------------------
router.get('/health', getAdminHealth);

export default router;
