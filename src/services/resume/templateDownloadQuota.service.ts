import { User, IUser } from '../../models/User';
import { getPlan } from '../subscriptionPlans.service';
import { ApiError } from '../../utils/ApiError';

/**
 * Per-user resume-template download quota.
 *
 * The limit is `SubscriptionPlan.templateDownloadsPerMonth` for the
 * user's active tier:
 *   `-1` → unlimited
 *   `0`  → feature blocked for this tier
 *   `n`  → up to `n` downloads in a calendar month (IST)
 *
 * Counter lives on the User document as a small subdocument so we don't
 * have to spin up a separate collection just for this. `periodStart`
 * stores the month boundary the counter was opened in; when a download
 * arrives in a new month we reset both fields atomically.
 *
 * IST is the chosen reset boundary because the rest of the app's
 * quota logic (AI calls) already resets at IST midnight, so users see
 * one consistent monthly clock.
 */

export interface QuotaStatus {
  tier: string;
  limit: number; // -1 = unlimited
  used: number;
  remaining: number; // Infinity for unlimited
  unlimited: boolean;
  periodStart: Date;
  /** Next reset boundary — useful for "Resets on Mar 1" copy. */
  resetsAt: Date;
}

const IST_OFFSET_MIN = 330; // UTC+5:30

const istMonthBoundaries = (now = new Date()): { start: Date; nextStart: Date } => {
  // Convert "now" to an IST clock, snap to the first of the month at
  // midnight IST, then convert back to UTC for storage. The DB stores
  // UTC; only the boundary calculation pretends to be IST.
  const utcMs = now.getTime();
  const istMs = utcMs + IST_OFFSET_MIN * 60 * 1000;
  const ist = new Date(istMs);
  const startIstMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1, 0, 0, 0);
  const nextStartIstMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1, 0, 0, 0);
  return {
    start: new Date(startIstMs - IST_OFFSET_MIN * 60 * 1000),
    nextStart: new Date(nextStartIstMs - IST_OFFSET_MIN * 60 * 1000),
  };
};

const userTier = (user: IUser): string =>
  user.subscription?.tier || 'free';

const currentCounter = (
  user: IUser,
): { count: number; periodStart: Date } => {
  const raw = (user as unknown as {
    templateDownloads?: { count?: number; periodStart?: Date };
  }).templateDownloads;
  return {
    count: raw?.count ?? 0,
    periodStart: raw?.periodStart ?? new Date(0),
  };
};

/**
 * Returns the user's quota status. Cheap — pulls the plan from cache
 * and inspects an in-document counter, no extra round-trips.
 */
export const getTemplateDownloadStatus = async (
  user: IUser,
): Promise<QuotaStatus> => {
  const tier = userTier(user);
  const plan = await getPlan(tier);
  const limit = plan?.templateDownloadsPerMonth ?? 0;
  const { start, nextStart } = istMonthBoundaries();
  const { count, periodStart } = currentCounter(user);

  // If the stored periodStart is older than this month's IST start,
  // we treat the counter as already reset.
  const inThisPeriod = periodStart.getTime() >= start.getTime();
  const used = inThisPeriod ? count : 0;
  const unlimited = limit < 0;
  const remaining = unlimited
    ? Number.POSITIVE_INFINITY
    : Math.max(0, limit - used);

  return {
    tier,
    limit,
    used,
    remaining,
    unlimited,
    periodStart: inThisPeriod ? periodStart : start,
    resetsAt: nextStart,
  };
};

/**
 * Atomic-ish increment + cap check. We do a single conditional update
 * that only increments when the user is still under the cap, so a
 * concurrent second download in the same millisecond can't double-spend
 * the final slot.
 *
 * Returns the new status. Throws `ApiError.forbidden(...)` if the cap
 * was reached.
 */
export const consumeTemplateDownload = async (
  user: IUser,
): Promise<QuotaStatus> => {
  const status = await getTemplateDownloadStatus(user);
  if (status.limit === 0) {
    throw ApiError.forbidden(
      'Resume template downloads aren\'t available on your current plan.',
    );
  }
  if (!status.unlimited && status.remaining <= 0) {
    throw ApiError.forbidden(
      `Monthly limit of ${status.limit} downloads reached. Resets ${status.resetsAt.toISOString().slice(0, 10)}.`,
    );
  }

  const { start } = istMonthBoundaries();
  const inThisPeriod =
    status.periodStart.getTime() >= start.getTime() && status.used > 0;

  // Single update: if the stored counter is from this period, increment
  // it only when still below the cap. Otherwise reset the period and
  // start at 1.
  let updated;
  if (status.unlimited) {
    updated = await User.findOneAndUpdate(
      { _id: user._id },
      inThisPeriod
        ? { $inc: { 'templateDownloads.count': 1 } }
        : {
            $set: {
              'templateDownloads.count': 1,
              'templateDownloads.periodStart': start,
            },
          },
      { new: true },
    );
  } else if (inThisPeriod) {
    updated = await User.findOneAndUpdate(
      {
        _id: user._id,
        'templateDownloads.count': { $lt: status.limit },
      },
      { $inc: { 'templateDownloads.count': 1 } },
      { new: true },
    );
    if (!updated) {
      throw ApiError.forbidden(
        `Monthly limit of ${status.limit} downloads reached. Resets ${status.resetsAt.toISOString().slice(0, 10)}.`,
      );
    }
  } else {
    updated = await User.findOneAndUpdate(
      { _id: user._id },
      {
        $set: {
          'templateDownloads.count': 1,
          'templateDownloads.periodStart': start,
        },
      },
      { new: true },
    );
  }

  if (!updated) {
    throw ApiError.internal('Failed to record template download');
  }
  return getTemplateDownloadStatus(updated);
};
