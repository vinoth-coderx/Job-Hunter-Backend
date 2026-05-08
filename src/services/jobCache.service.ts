import { Job } from '../models/Job';
import { env } from '../config/env';

export const buildAllJobsPayload = async (): Promise<{
  success: true;
  data: unknown[];
  meta: { total: number; freshnessDays: number; servedAt: string };
}> => {
  const cutoff = new Date(Date.now() - env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
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
      freshnessDays: env.JOB_FRESHNESS_DAYS,
      servedAt: new Date().toISOString(),
    },
  };
};
