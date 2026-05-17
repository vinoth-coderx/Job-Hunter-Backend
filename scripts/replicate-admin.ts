import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from '../src/models/User';
import { logger } from '../src/utils/logger';

/**
 * Copy an admin user from one Mongo cluster to the other so the
 * runtime-mode flip in the admin UI doesn't lock the operator out.
 * Default direction is `--from=live --to=test`. Pass `--from=test` to
 * mirror the other way.
 *
 *   npm run replicate:admin -- --email=you@example.com
 *   npm run replicate:admin -- --email=you@example.com --from=test
 *
 * Idempotent. Re-running on a user that already exists in the target
 * cluster updates the password hash + isAdmin flag in place; nothing
 * else is touched.
 *
 * Requires both `MONGODB_URI` (test/dev) and `MONGODB_URI_PROD` (live)
 * in the .env file.
 */

const parseArgs = (): Record<string, string | boolean> => {
  const args: Record<string, string | boolean> = {};
  for (const raw of process.argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) args[raw.slice(2)] = true;
    else args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
};

const connectWith = async (uri: string, label: string): Promise<mongoose.Connection> => {
  const conn = mongoose.createConnection(uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
  });
  await conn.asPromise();
  logger.info(`Connected to ${label} Mongo`);
  return conn;
};

(async () => {
  const args = parseArgs();
  const email =
    typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
  const direction = args.from === 'test' ? 'test->live' : 'live->test';

  if (!email) {
    console.error(
      'Usage: npm run replicate:admin -- --email=user@example.com [--from=test|live]',
    );
    process.exit(1);
  }

  const liveUri = process.env.MONGODB_URI_PROD;
  const testUri = process.env.MONGODB_URI;

  if (!liveUri || !testUri) {
    console.error(
      'Both MONGODB_URI (test) and MONGODB_URI_PROD (live) must be set in .env',
    );
    process.exit(1);
  }

  const sourceUri = direction === 'live->test' ? liveUri : testUri;
  const targetUri = direction === 'live->test' ? testUri : liveUri;
  const sourceLabel = direction === 'live->test' ? 'live' : 'test';
  const targetLabel = direction === 'live->test' ? 'test' : 'live';

  let source: mongoose.Connection | null = null;
  let target: mongoose.Connection | null = null;

  try {
    [source, target] = await Promise.all([
      connectWith(sourceUri, sourceLabel),
      connectWith(targetUri, targetLabel),
    ]);

    // Bind the User model to each connection separately. Using
    // `User.schema` reuses the existing schema definition without
    // touching the default mongoose connection.
    const SourceUser = source.model('User', User.schema);
    const TargetUser = target.model('User', User.schema);

    const src = await SourceUser.findOne({ email }).lean();
    if (!src) {
      console.error(`No user "${email}" in ${sourceLabel} Mongo.`);
      process.exit(2);
    }
    if (!src.isAdmin) {
      console.error(
        `User "${email}" in ${sourceLabel} is not an admin. Promote there first via seed:admin.`,
      );
      process.exit(3);
    }

    const existing = await TargetUser.findOne({ email });
    if (existing) {
      existing.password = src.password;
      existing.isAdmin = true;
      existing.role = src.role;
      existing.profile = src.profile;
      await existing.save();
      logger.info(`${email} updated in ${targetLabel} Mongo (admin promoted).`);
    } else {
      // Strip _id so Mongo issues a fresh one for the target cluster.
      const clone: Record<string, unknown> = { ...src };
      delete clone._id;
      delete clone.createdAt;
      delete clone.updatedAt;
      clone.isAdmin = true;
      await TargetUser.create(clone);
      logger.info(`${email} created in ${targetLabel} Mongo (admin).`);
    }
  } catch (err) {
    logger.error('replicate-admin failed', err);
    process.exitCode = 1;
  } finally {
    await Promise.all([source?.close(), target?.close()]).catch(() => {});
  }
})();
