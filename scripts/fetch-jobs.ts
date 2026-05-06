import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { connectRedis, disconnectRedis } from '../src/config/redis';
import { fetchAllJobs, puppeteerScraper } from '../src/services/scrapers';
import { logger } from '../src/utils/logger';

(async () => {
  try {
    await connectDatabase();
    await connectRedis();

    logger.info('Manual fetch starting...');
    const result = await fetchAllJobs();
    logger.info('Manual fetch result', result);
  } catch (err) {
    logger.error('Manual fetch failed', err);
    process.exitCode = 1;
  } finally {
    await puppeteerScraper.close().catch(() => {});
    await disconnectRedis().catch(() => {});
    await disconnectDatabase().catch(() => {});
    process.exit();
  }
})();
