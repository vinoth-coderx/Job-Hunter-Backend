import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { User } from '../src/models/User';
import { logger } from '../src/utils/logger';

/**
 * Create-or-promote an admin account. Use when there's nobody in the
 * DB yet (fresh deploy) or when you want to provision an admin without
 * going through the consumer signup flow.
 *
 *   npm run create:admin -- --email=admin@example.com --password='Strong!23' --name='Admin'
 *
 * If the email already exists, the script just flips `isAdmin` to true
 * and (optionally) resets the password. Otherwise it creates a fresh
 * User document with isAdmin=true. Idempotent — safe to re-run.
 */

const parseArgs = (): Record<string, string> => {
  const args: Record<string, string> = {};
  for (const raw of process.argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) args[raw.slice(2)] = 'true';
    else args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return args;
};

(async () => {
  const args = parseArgs();
  const email = (args.email ?? '').trim().toLowerCase();
  const password = args.password ?? '';
  const fullName = (args.name ?? 'Admin').trim();

  if (!email || !password) {
    console.error(
      "Usage: npm run create:admin -- --email=admin@example.com --password='Strong!23' [--name='Admin']",
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  try {
    await connectDatabase();
    let user = await User.findOne({ email }).select('+password');
    if (user) {
      user.password = password; // pre-save hook bcrypts it
      user.isAdmin = true;
      user.isEmailVerified = true;
      user.activeRole = user.activeRole ?? 'seeker';
      await user.save();
      logger.info(`[create-admin] existing user "${email}" → admin, password reset.`);
    } else {
      user = await User.create({
        email,
        password,
        authProvider: 'local',
        isAdmin: true,
        isEmailVerified: true,
        activeRole: 'seeker',
        profile: {
          fullName,
          skills: [],
          experienceYears: 0,
          preferredRoles: [],
          preferredLocations: [],
          preferredJobTypes: [],
          preferredRemote: [],
        },
        subscription: { tier: 'free', status: 'active' },
      });
      logger.info(`[create-admin] new admin "${email}" created.`);
    }
    logger.info(`[create-admin] ready. Sign in to the admin console with this email + password.`);
  } catch (err) {
    logger.error('[create-admin] failed', err);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => {});
  }
})();
