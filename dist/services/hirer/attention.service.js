"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildHirerAttention = void 0;
const Job_1 = require("../../models/Job");
const JobModeration_1 = require("../../models/JobModeration");
const AppliedJob_1 = require("../../models/AppliedJob");
const STALE_AFTER_DAYS = 14;
const TOP_MATCH_AI_SCORE = 75;
const buildHirerAttention = async (hirerProfileId) => {
    const staleCutoff = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000);
    const [appeals, flagged, topMatches, staleJobs] = await Promise.all([
        JobModeration_1.JobModeration.find({
            company: hirerProfileId,
            'appeal.status': 'pending',
        })
            .sort({ 'appeal.submittedAt': 1 })
            .limit(5)
            .populate('job', 'title')
            .lean(),
        JobModeration_1.JobModeration.find({
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
        AppliedJob_1.AppliedJob.find({
            hirerProfile: hirerProfileId,
            'aiRanking.score': { $gte: TOP_MATCH_AI_SCORE },
            status: { $in: ['applied', 'viewed'] },
        })
            .sort({ 'aiRanking.score': -1, appliedAt: -1 })
            .limit(5)
            .populate('user', 'profile.fullName')
            .populate('job', 'title')
            .lean(),
        Job_1.Job.aggregate([
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
    const appealsRow = {
        count: appeals.length,
        topItem: appeals[0] && appeals[0].job
            ? {
                id: appeals[0].job
                    ._id.toString(),
                label: appeals[0].job.title ??
                    'Pending appeal',
            }
            : null,
    };
    const flaggedRow = {
        count: flagged.length,
        topItem: flagged[0] && flagged[0].job
            ? {
                id: flagged[0].job._id.toString(),
                label: flagged[0].job.title ??
                    'Flagged listing',
            }
            : null,
    };
    const topMatchRow = {
        count: topMatches.length,
        topItem: topMatches[0] && topMatches[0].user && topMatches[0].job
            ? {
                id: topMatches[0]._id.toString(),
                label: `${topMatches[0].user.profile?.fullName ?? 'Strong match'} · ${topMatches[0].job.title ?? ''}`,
            }
            : null,
    };
    const staleRow = {
        count: staleJobs.length,
        topItem: staleJobs[0] !== undefined
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
        total: appealsRow.count +
            flaggedRow.count +
            topMatchRow.count +
            staleRow.count,
    };
};
exports.buildHirerAttention = buildHirerAttention;
