import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { Job } from '../src/models/Job';
import { logger } from '../src/utils/logger';

// One-shot fixer for the legacy unique index on `externalId`. Earlier
// schema versions declared `{ externalId: 1 }` unique without a partial
// filter; native jobs (which leave externalId undefined / null) then
// collided on the unique constraint, producing the
// "Duplicate value for field: externalId" error at insert time.
//
// The current schema declares a partial-filter compound unique index
// `{ externalId: 1, source: 1 }` that only fires when externalId is a
// string — but Mongo doesn't auto-rebuild an index when its definition
// changes in code. This script drops any index on externalId that
// doesn't match the partial-filter expectation, then asks Mongoose to
// (re)create the indexes from the current schema.
(async () => {
  try {
    await connectDatabase();
    const coll = Job.collection;

    const idx = await coll.indexes();
    logger.info(`Job collection has ${idx.length} indexes`);

    // Pass 1 — drop legacy externalId unique-without-partial-filter index.
    for (const i of idx) {
      const keys = Object.keys(i.key);
      const touchesExternalId = keys.includes('externalId');
      if (!touchesExternalId) continue;
      const isPartial =
        typeof i.partialFilterExpression === 'object' &&
        i.partialFilterExpression !== null;
      if (i.unique && !isPartial) {
        logger.warn(
          `Dropping legacy non-partial unique index "${i.name}" on ${JSON.stringify(i.key)}`,
        );
        await coll.dropIndex(i.name as string);
      }
    }

    // Pass 2 — Mongo only allows ONE text index per collection, but the
    // existing one ("title_text", weight on title only) doesn't match the
    // compound { title, company, description, skills } text index the
    // current schema declares. Drop every text index and recreate the
    // compound one explicitly. We can't rely on Mongoose syncIndexes()
    // for this because it sees the key shape `{_fts,_ftsx}` as equivalent
    // and refuses to replace the index in-place.
    for (const i of idx) {
      const isTextIndex =
        i.key && Object.values(i.key).some((v) => v === 'text');
      if (!isTextIndex) continue;
      logger.warn(
        `Dropping legacy text index "${i.name}" (weights=${JSON.stringify(i.weights ?? {})})`,
      );
      await coll.dropIndex(i.name as string);
    }

    logger.info('Creating compound text index on title/company/description/skills…');
    await coll.createIndex(
      { title: 'text', company: 'text', description: 'text', skills: 'text' },
      { name: 'jobs_text_search', background: true },
    );

    logger.info('Re-syncing remaining Job indexes from current schema…');
    await Job.syncIndexes();
    const after = await coll.indexes();
    logger.info(
      `Done. Job collection now has ${after.length} indexes:\n${after
        .map((i) => `  • ${i.name}: ${JSON.stringify(i.key)}${i.unique ? ' [unique]' : ''}${
          i.partialFilterExpression ? ' [partial]' : ''
        }`)
        .join('\n')}`,
    );
  } catch (err) {
    logger.error('fix-job-indexes failed', err);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => {});
    process.exit();
  }
})();
