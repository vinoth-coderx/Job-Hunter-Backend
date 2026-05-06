import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { logger } from '../src/utils/logger';

const KEEP = new Set(['users']);

(async () => {
  try {
    await connectDatabase();
    const db = mongoose.connection.db;
    if (!db) throw new Error('No db handle');

    const cols = await db.listCollections().toArray();
    const targets = cols.map((c) => c.name).filter((n) => !KEEP.has(n) && !n.startsWith('system.'));

    logger.info(`Found ${cols.length} collections. Keeping: [${[...KEEP].join(', ')}]. Dropping: [${targets.join(', ')}]`);

    for (const name of targets) {
      const before = await db.collection(name).countDocuments();
      await db.collection(name).deleteMany({});
      logger.info(`Cleared ${name} (${before} docs removed)`);
    }

    const userCount = await db.collection('users').countDocuments().catch(() => 0);
    logger.info(`Done. users collection retained with ${userCount} docs.`);
  } catch (err) {
    logger.error('Clear DB failed', err);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => {});
    process.exit();
  }
})();
