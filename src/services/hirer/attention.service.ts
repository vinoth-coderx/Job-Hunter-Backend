import mongoose from 'mongoose';
import { Job } from '../../models/Job';
import { JobModeration } from '../../models/JobModeration';
import { AppliedJob } from '../../models/AppliedJob';

/**
 * "Needs attention" snapshot for the hirer dashboard. Pure data
 * aggregation — no AI cost. Surfaces the four most common pipeline
 * blockers so the hirer sees what to act on the moment they land.
 *
 * Categories:
 *   - moderationAppeals — pending admin review for THIS hirer's jobs
 *   - moderationFlagged — jobs in `queued` / `auto_rejected`
 *   - unreviewedTopMatches — applicants with high AI score still in
 *     `applied`/`viewed` state (haven't been shortlisted/rejected yet)
 *   - staleJobs — active jobs with no applicants in the last 14 days
 *
 * Each row carries a count + ONE example so the dashboard card can
 * render "3 high matches need review" with a tap-target on the top
 * candidate without a follow-up fetch.
 */

export interface AttentionRow {
  count: number;
  /** First example for the row (ID + label) — null when count === 0. */
  topItem: { id: string; label: string } | null;
}

export interface HirerAttention {
  moderationAppeals: AttentionRow;
  moderationFlagged: AttentionRow;
  unreviewedTopMatches: AttentionRow;
  staleJobs: AttentionRow;
  /** Sum across all four categories — used to render the badge count. */
  total: number;
}

const STALE_AFTER_DAYS = 14;
const TOP_MATCH_AI_SCORE = 75;

export const buildHirerAttention = async (
  hirerProfileId: mongoose.Types.ObjectId,
): Promise<HirerAttention> => {
  const staleCutoff = new Date(
    Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  );

  // 1) Pending moderation appeals — JobModeration rows with appeal.status === 'pending'.
  // 2) Flagged — moderation decision queued or auto_rejected with no admin override.
  // 3) Top matches — AppliedJob with aiRanking.score >= 75 + status in {applied, viewed}.
  // 4) Stale jobs — Job.publishedAt > staleCutoff && no applications in the window.
  //
  // We fan these out in parallel since none depend on each other.
  const [appeals, flagged, topMatches, staleJobs] = await Promise.all([
    JobModeration.find({
      company: hirerProfileId,
      'appeal.status': 'pending',
    })
      .sort({ 'appeal.submittedAt': 1 })
      .limit(5)
      .populate('job', 'title')
      .lean(),

    JobModeration.find({
      company: hirerProfileId,
      $or: [
        { decision: 'queued', overrideDecision: { $exists: false } },
        { decision: 'auto_rejected', overrideDecision: { $exists: false } },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('job', 'title')
      .lean(),

    AppliedJob.find({
      hirerProfile: hirerProfileId,
      'aiRanking.score': { $gte: TOP_MATCH_AI_SCORE },
      status: { $in: ['applied', 'viewed'] },
    })
      .sort({ 'aiRanking.score': -1, appliedAt: -1 })
      .limit(5)
      .populate('user', 'profile.fullName')
      .populate('job', 'title')
      .lean(),

    Job.aggregate<{
      _id: mongoose.Types.ObjectId;
      title: string;
      lastApp?: Date;
    }>([
      {
        $match: {
          hirerProfile: hirerProfileId,
          isNative: true,
          status: 'active',
        },
      },
      {
        $lookup: {
          from: 'appliedjobs',
          let: { jobId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$job', '$$jobId'] } } },
            { $sort: { appliedAt: -1 } },
            { $limit: 1 },
            { $project: { appliedAt: 1 } },
          ],
          as: 'lastAppDoc',
        },
      },
      {
        $project: {
          title: 1,
          lastApp: { $first: '$lastAppDoc.appliedAt' },
        },
      },
      {
        $match: {
          $or: [
            { lastApp: { $exists: false } },
            { lastApp: { $lt: staleCutoff } },
          ],
        },
      },
      { $limit: 5 },
    ]),
  ]);

  const appealsRow: AttentionRow = {
    count: appeals.length,
    topItem:
      appeals[0] && appeals[0].job
        ? {
            id: (appeals[0].job as unknown as { _id: mongoose.Types.ObjectId })
              ._id.toString(),
            label:
              (appeals[0].job as unknown as { title?: string }).title ??
              'Pending appeal',
          }
        : null,
  };

  const flaggedRow: AttentionRow = {
    count: flagged.length,
    topItem:
      flagged[0] && flagged[0].job
        ? {
            id: (flagged[0].job as unknown as {
              _id: mongoose.Types.ObjectId;
            })._id.toString(),
            label:
              (flagged[0].job as unknown as { title?: string }).title ??
              'Flagged listing',
          }
        : null,
  };

  const topMatchRow: AttentionRow = {
    count: topMatches.length,
    topItem:
      topMatches[0] && topMatches[0].user && topMatches[0].job
        ? {
            id: topMatches[0]._id.toString(),
            label: `${
              (topMatches[0].user as unknown as {
                profile?: { fullName?: string };
              }).profile?.fullName ?? 'Strong match'
            } · ${
              (topMatches[0].job as unknown as { title?: string }).title ?? ''
            }`,
          }
        : null,
  };

  const staleRow: AttentionRow = {
    count: staleJobs.length,
    topItem:
      staleJobs[0] !== undefined
        ? {
            id: staleJobs[0]._id.toString(),
            label: staleJobs[0].title,
          }
        : null,
  };

  return {
    moderationAppeals: appealsRow,
    moderationFlagged: flaggedRow,
    unreviewedTopMatches: topMatchRow,
    staleJobs: staleRow,
    total:
      appealsRow.count +
      flaggedRow.count +
      topMatchRow.count +
      staleRow.count,
  };
};
