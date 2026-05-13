import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { User } from '../src/models/User';
import { logger } from '../src/utils/logger';

/**
 * Promote an existing user to admin. Usage:
 *
 *   npm run seed:admin -- --email=you@example.com
 *
 * The user must already have signed up via the consumer app (Flutter or
 * Firebase Auth). This script never creates a User; it just flips the
 * `isAdmin` flag. Idempotent — re-running on an already-admin is a no-op.
 *
 * Use `--demote` to reverse the operation.
 */
const parseArgs = () => {
  const args: Record<string, string | boolean> = {};
  for (const raw of process.argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) args[raw.slice(2)] = true;
    else args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
};

(async () => {
  const args = parseArgs();
  const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
  const demote = args.demote === true;

  if (!email) {
    console.error('Usage: npm run seed:admin -- --email=user@example.com [--demote]');
    process.exit(1);
  }

  try {
    await connectDatabase();
    const user = await User.findOne({ email });
    if (!user) {
      console.error(`No user found with email "${email}". Sign up via the app first.`);
      process.exit(2);
    }

    if (demote) {
      if (!user.isAdmin) {
        logger.info(`${email} was not an admin — nothing to do.`);
      } else {
        user.isAdmin = false;
        await user.save();
        logger.info(`${email} demoted — admin access revoked.`);
      }
    } else {
      if (user.isAdmin) {
        logger.info(`${email} is already an admin — nothing to do.`);
      } else {
        user.isAdmin = true;
        await user.save();
        logger.info(`${email} promoted — admin access granted.`);
      }
    }
  } catch (err) {
    logger.error('seed-admin failed', err);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => {});
  }
})();
