import { AppliedJob } from '../models/AppliedJob';
import { Job } from '../models/Job';
import { logger } from '../utils/logger';

/// Older applications were created without a `hirerProfile` link, which is
/// what the hirer-side applicants list filters on. Backfill it from the
/// related Job so existing applications show up in the hirer dashboard.
/// Idempotent — only touches rows that are missing the link.
export const backfillApplicantHirerLinks = async (): Promise<void> => {
  try {
    // Backfill is native-only — external (scraped) applications have no
    // hirerProfile to link to. Filter to records that still carry a job ref.
    const orphans = (
      await AppliedJob.find({
        $or: [{ hirerProfile: { $exists: false } }, { hirerProfile: null }],
        job: { $exists: true },
      })
        .select('_id job')
        .limit(2000)
        .lean()
    ).filter((a) => a.job);

    if (orphans.length === 0) return;

    const jobIds = [...new Set(orphans.map((a) => a.job!.toString()))];
    const jobs = await Job.find({ _id: { $in: jobIds } })
      .select('_id hirerProfile')
      .lean();

    const map = new Map<string, string>();
    for (const j of jobs) {
      if (j.hirerProfile) map.set(j._id.toString(), j.hirerProfile.toString());
    }

    let updated = 0;
    for (const a of orphans) {
      const hp = map.get(a.job!.toString());
      if (!hp) continue;
      await AppliedJob.updateOne(
        { _id: a._id },
        { $set: { hirerProfile: hp } },
      );
      updated++;
    }

    if (updated > 0) {
      logger.info(`Backfilled hirerProfile on ${updated} applications`);
    }
  } catch (err) {
    logger.warn('Applicant hirer backfill failed', err);
  }
};
