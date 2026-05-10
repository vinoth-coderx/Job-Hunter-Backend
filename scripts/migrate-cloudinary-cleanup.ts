/**
 * One-time migration: clear stale file references that point at the old
 * disk-based upload paths (`/api/v1/users/avatar/...`, `/api/v1/hirer/...`)
 * or have no Cloudinary public_id. Run this AFTER deploying the
 * Cloudinary-backed code; existing rows will lose their now-broken file
 * pointers, and clients will be prompted to re-upload.
 *
 * Usage:
 *   npx tsx scripts/migrate-cloudinary-cleanup.ts          # dry run
 *   npx tsx scripts/migrate-cloudinary-cleanup.ts --apply  # write changes
 */

import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { logger } from '../src/utils/logger';
import { User } from '../src/models/User';
import { HirerProfile } from '../src/models/HirerProfile';

const APPLY = process.argv.includes('--apply');

const isCloudinaryUrl = (url: string | undefined | null): boolean =>
  Boolean(url && /^https?:\/\/[^/]*cloudinary\.com\//i.test(url));

(async () => {
  try {
    await connectDatabase();
    logger.info(`Migration mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY-RUN (no writes)'}`);

    // ── Users ────────────────────────────────────────────────────────
    let usersScanned = 0;
    let avatarCleared = 0;
    let resumeCleared = 0;
    const userCursor = User.find({}, {
      'profile.avatar': 1,
      'profile.avatarFile': 1,
      'profile.resumeUrl': 1,
      'profile.resumeFile': 1,
    }).cursor();

    for await (const user of userCursor) {
      usersScanned += 1;
      let dirty = false;

      const af = user.profile.avatarFile;
      if (af && !af.publicId) {
        if (APPLY) {
          user.profile.avatarFile = undefined;
          user.profile.avatar = undefined;
        }
        avatarCleared += 1;
        dirty = true;
      } else if (af?.publicId && !isCloudinaryUrl(user.profile.avatar)) {
        // publicId exists but the public `avatar` URL is stale.
        if (APPLY) user.profile.avatar = af.url;
        dirty = true;
      }

      const rf = user.profile.resumeFile;
      if (rf && !rf.publicId) {
        if (APPLY) {
          user.profile.resumeFile = undefined;
          user.profile.resumeUrl = undefined;
          // Keep resumeText — that data was extracted at upload time
          // and still has value for AI matching.
        }
        resumeCleared += 1;
        dirty = true;
      }

      if (dirty && APPLY) await user.save();
    }

    // ── Hirer profiles ───────────────────────────────────────────────
    let hirersScanned = 0;
    let logosCleared = 0;
    let photoUrlsRemoved = 0;
    const hirerCursor = HirerProfile.find({}, {
      companyLogoUrl: 1,
      companyLogoPublicId: 1,
      officePhotos: 1,
    }).cursor();

    for await (const hirer of hirerCursor) {
      hirersScanned += 1;
      let dirty = false;

      // Logo: clear if URL exists but isn't from Cloudinary.
      if (hirer.companyLogoUrl && !isCloudinaryUrl(hirer.companyLogoUrl)) {
        if (APPLY) {
          hirer.companyLogoUrl = undefined;
          hirer.companyLogoPublicId = undefined;
        }
        logosCleared += 1;
        dirty = true;
      }

      // Office photos: drop any non-Cloudinary entries.
      if (hirer.officePhotos.length > 0) {
        const cleaned = hirer.officePhotos.filter(isCloudinaryUrl);
        const dropped = hirer.officePhotos.length - cleaned.length;
        if (dropped > 0) {
          if (APPLY) hirer.officePhotos = cleaned;
          photoUrlsRemoved += dropped;
          dirty = true;
        }
      }

      if (dirty && APPLY) await hirer.save();
    }

    logger.info('─────────────────────────────────────────────');
    logger.info(`Users scanned:             ${usersScanned}`);
    logger.info(`  avatarFile cleared:      ${avatarCleared}`);
    logger.info(`  resumeFile cleared:      ${resumeCleared}`);
    logger.info(`Hirer profiles scanned:    ${hirersScanned}`);
    logger.info(`  stale logos cleared:     ${logosCleared}`);
    logger.info(`  stale photo URLs removed:${photoUrlsRemoved}`);
    logger.info('─────────────────────────────────────────────');
    if (!APPLY) {
      logger.info('Re-run with --apply to commit these changes.');
    }
  } catch (err) {
    logger.error('Migration failed', err);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => {});
    process.exit();
  }
})();
