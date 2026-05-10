import 'dotenv/config';
import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { API_VERSION } from './config/constants';
import { connectDatabase, disconnectDatabase } from './config/database';
import { connectRedis, disconnectRedis } from './config/redis';
import { startJobScraperCron, stopJobScraperCron } from './jobs/jobScraper.cron';
import { startAlertCheckerCron, stopAlertCheckerCron } from './jobs/alertChecker.cron';
import { startAutoApplyCron, stopAutoApplyCron } from './jobs/autoApply.cron';
import { backfillApplicantHirerLinks } from './jobs/backfillApplicantHirer';
import { initSocket, closeSocket } from './services/chat/socket';
import { puppeteerScraper } from './services/scrapers';
import { logger } from './utils/logger';

let server: http.Server;

const start = async (): Promise<void> => {
  try {
    await connectDatabase();
    await connectRedis();

    const app = createApp();
    server = http.createServer(app);
    initSocket(server);

    server.listen(env.PORT, () => {
      const base = `http://localhost:${env.PORT}`;
      const api = `${base}/api/${API_VERSION}`;
      logger.info('================================================');
      logger.info(`  Job Hunter Backend  [${env.NODE_ENV}]`);
      logger.info('================================================');
      logger.info(`  Server   : ${base}`);
      logger.info(`  API base : ${api}`);
      logger.info(`  Health   : ${api}/health`);
      logger.info(`  Ready    : ${api}/health/ready`);
      logger.info(`  Deep     : ${api}/health/deep`);
      logger.info(`  Auth     : ${api}/auth/{register,login,me}`);
      logger.info(`  Jobs     : ${api}/jobs   (auth: default = 80% matched feed)`);
      logger.info(`  Search   : ${api}/jobs?q=&location=&skills=...   (auth: search across pool)`);
      logger.info(`  Feed     : ${api}/jobs/feed   (auth: explicit matched feed)`);
      logger.info('================================================');
      startJobScraperCron();
      startAlertCheckerCron();
      startAutoApplyCron();
      void backfillApplicantHirerLinks();
    });
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  logger.info(`${signal} received — shutting down gracefully`);
  stopJobScraperCron();
  stopAlertCheckerCron();
  stopAutoApplyCron();
  await closeSocket().catch((e) => logger.warn('Socket close failed', e));

  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  try {
    await puppeteerScraper.close();
  } catch (err) {
    logger.warn('Puppeteer close failed', err);
  }

  await disconnectRedis().catch((e) => logger.warn('Redis disconnect failed', e));
  await disconnectDatabase().catch((e) => logger.warn('DB disconnect failed', e));

  logger.info('Shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err);
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
});

void start();
