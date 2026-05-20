"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("./bootstrap/patchMongoose");
require("dotenv/config");
const http_1 = __importDefault(require("http"));
const app_1 = require("./app");
const env_1 = require("./config/env");
const constants_1 = require("./config/constants");
const dbConnections_1 = require("./config/dbConnections");
const multiConnModel_1 = require("./utils/multiConnModel");
const redis_1 = require("./config/redis");
const config_service_1 = require("./services/config/config.service");
const aiKeySync_service_1 = require("./services/ai/aiKeySync.service");
const jobSourceConfig_service_1 = require("./services/jobSourceConfig.service");
const jobScraper_cron_1 = require("./jobs/jobScraper.cron");
const alertChecker_cron_1 = require("./jobs/alertChecker.cron");
const autoApply_cron_1 = require("./jobs/autoApply.cron");
const recommendedJobs_cron_1 = require("./jobs/recommendedJobs.cron");
const trustMaintenance_cron_1 = require("./jobs/trustMaintenance.cron");
const candidateSuggestionsWarmup_cron_1 = require("./jobs/candidateSuggestionsWarmup.cron");
const aiCostAlert_cron_1 = require("./jobs/aiCostAlert.cron");
const backfillApplicantHirer_1 = require("./jobs/backfillApplicantHirer");
const socket_1 = require("./services/chat/socket");
const scrapers_1 = require("./services/scrapers");
const resumePdf_service_1 = require("./services/resume/resumePdf.service");
const logger_1 = require("./utils/logger");
let server;
const start = async () => {
    try {
        await (0, dbConnections_1.connectAllDatabases)();
        (0, multiConnModel_1.bindAllRegisteredModels)();
        await (0, redis_1.connectRedis)();
        await (0, config_service_1.preloadAppConfig)().catch((err) => logger_1.logger.warn('AppConfig preload failed — continuing with env fallback', err));
        await (0, aiKeySync_service_1.syncAllProvidersToAppConfig)().catch((err) => logger_1.logger.warn('AiKey → AppConfig sync failed at boot — admin re-save will repair', err));
        await (0, jobSourceConfig_service_1.seedJobSourceConfigs)().catch((err) => logger_1.logger.warn('JobSourceConfig seed failed — pipeline still usable', err));
        const app = (0, app_1.createApp)();
        server = http_1.default.createServer(app);
        (0, socket_1.initSocket)(server);
        server.listen(env_1.env.PORT, () => {
            const base = `http://localhost:${env_1.env.PORT ?? 5000}`;
            const api = `${base}/api/${constants_1.API_VERSION}`;
            logger_1.logger.info('================================================');
            logger_1.logger.info(`  Job Hunter Backend  [${env_1.env.NODE_ENV}]`);
            logger_1.logger.info('================================================');
            logger_1.logger.info(`  Server   : ${base}`);
            logger_1.logger.info(`  API base : ${api}`);
            logger_1.logger.info(`  Health   : ${api}/health`);
            logger_1.logger.info(`  Ready    : ${api}/health/ready`);
            logger_1.logger.info(`  Deep     : ${api}/health/deep`);
            logger_1.logger.info(`  Auth     : ${api}/auth/{register,login,me}`);
            logger_1.logger.info(`  Jobs     : ${api}/jobs   (auth: default = 80% matched feed)`);
            logger_1.logger.info(`  Search   : ${api}/jobs?q=&location=&skills=...   (auth: search across pool)`);
            logger_1.logger.info(`  Feed     : ${api}/jobs/feed   (auth: explicit matched feed)`);
            logger_1.logger.info('================================================');
            (0, jobScraper_cron_1.startJobScraperCron)();
            (0, alertChecker_cron_1.startAlertCheckerCron)();
            (0, autoApply_cron_1.startAutoApplyCron)();
            (0, recommendedJobs_cron_1.startRecommendedJobsCron)();
            (0, trustMaintenance_cron_1.startTrustMaintenanceCron)();
            (0, candidateSuggestionsWarmup_cron_1.startCandidateSuggestionsWarmupCron)();
            (0, aiCostAlert_cron_1.startAiCostAlertCron)();
            void (0, backfillApplicantHirer_1.backfillApplicantHirerLinks)();
        });
    }
    catch (err) {
        logger_1.logger.error('Failed to start server', err);
        process.exit(1);
    }
};
const shutdown = async (signal) => {
    logger_1.logger.info(`${signal} received — shutting down gracefully`);
    (0, jobScraper_cron_1.stopJobScraperCron)();
    (0, alertChecker_cron_1.stopAlertCheckerCron)();
    (0, autoApply_cron_1.stopAutoApplyCron)();
    (0, recommendedJobs_cron_1.stopRecommendedJobsCron)();
    (0, trustMaintenance_cron_1.stopTrustMaintenanceCron)();
    (0, candidateSuggestionsWarmup_cron_1.stopCandidateSuggestionsWarmupCron)();
    (0, aiCostAlert_cron_1.stopAiCostAlertCron)();
    await (0, socket_1.closeSocket)().catch((e) => logger_1.logger.warn('Socket close failed', e));
    if (server) {
        await new Promise((resolve) => server.close(() => resolve()));
    }
    try {
        await scrapers_1.puppeteerScraper.close();
    }
    catch (err) {
        logger_1.logger.warn('Puppeteer close failed', err);
    }
    await (0, resumePdf_service_1.closeResumePdfBrowser)().catch((e) => logger_1.logger.warn('Resume PDF browser close failed', e));
    await (0, redis_1.disconnectRedis)().catch((e) => logger_1.logger.warn('Redis disconnect failed', e));
    await (0, dbConnections_1.disconnectAllDatabases)().catch((e) => logger_1.logger.warn('DB disconnect failed', e));
    logger_1.logger.info('Shutdown complete');
    process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    logger_1.logger.error('Uncaught exception', err);
    void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error('Unhandled rejection', reason);
});
void start();
