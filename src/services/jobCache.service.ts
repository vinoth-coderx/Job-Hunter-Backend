import { Job } from '../models/Job';
import { JOB_FRESHNESS_DAYS } from '../config/constants';

export const buildAllJobsPayload = async (): Promise<{
  success: true;
  data: unknown[];
  meta: { total: number; freshnessDays: number; servedAt: string };
}> => {
  const cutoff = new Date(Date.now() - JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
  const items = await Job.find(
    { isActive: true, postedAt: { $gte: cutoff } },
    { raw: 0 },
  )
    .sort({ postedAt: -1 })
    .lean();

  return {
    success: true,
    data: items,
    meta: {
      total: items.length,
      freshnessDays: JOB_FRESHNESS_DAYS,
      servedAt: new Date().toISOString(),
    },
  };
};
