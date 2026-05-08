import { Response } from 'express';
import { Job } from '../models/Job';
import { JobView } from '../models/JobView';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

/**
 * Records a job view. De-duplicated per (job, user) within 24h so that a
 * user opening the same listing repeatedly only counts once. Counters on
 * the Job document are incremented atomically.
 *
 * Anonymous device-id fallback is supported via header `x-device-id` so
 * guests browsing the home feed still feed the analytics — without
 * exposing identifying information.
 */
export const recordJobView = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = String(req.params.id || '');
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid job id');

  const job = await Job.findById(id).select('_id').lean();
  if (!job) throw ApiError.notFound('Job not found');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const userId = req.user?._id;
  const deviceIdRaw = req.header('x-device-id');
  const deviceId = typeof deviceIdRaw === 'string' && deviceIdRaw.length > 0 && deviceIdRaw.length <= 200
    ? deviceIdRaw
    : undefined;

  // Either user OR deviceId must be present to dedupe.
  if (!userId && !deviceId) {
    res.json({ success: true, counted: false, reason: 'no-identity' });
    return;
  }

  const dedupeFilter: Record<string, unknown> = userId
    ? { job: id, user: userId, viewedAt: { $gte: since } }
    : { job: id, deviceId, user: { $exists: false }, viewedAt: { $gte: since } };

  const existing = await JobView.findOne(dedupeFilter).select('_id').lean();
  if (existing) {
    res.json({ success: true, counted: false });
    return;
  }

  await JobView.create({
    job: id,
    ...(userId ? { user: userId } : {}),
    ...(deviceId ? { deviceId } : {}),
    viewedAt: new Date(),
  });

  // Atomically bump the denormalised counter on the job. Best-effort —
  // a failed inc shouldn't fail the request now that the JobView row was
  // already saved.
  try {
    await Job.updateOne({ _id: id }, { $inc: { viewsCount: 1 } });
  } catch {
    // ignore
  }

  res.json({ success: true, counted: true });
});
