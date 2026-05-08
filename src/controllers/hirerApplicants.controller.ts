import { Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { AppliedJob, ApplicationStatus, IAppliedJob } from '../models/AppliedJob';
import { Job } from '../models/Job';
import { HirerProfile } from '../models/HirerProfile';
import { IUser } from '../models/User';
import { Notification } from '../models/Notification';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

const HIRER_STATUSES = [
  'applied',
  'viewed',
  'shortlisted',
  'interview',
  'offer',
  'hired',
  'rejected',
] as const;

export const listApplicantsSchema = z.object({
  query: z.object({
    status: z
      .enum(['all', ...HIRER_STATUSES])
      .default('all'),
    minMatch: z.coerce.number().min(0).max(100).optional(),
    skill: z.string().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(['recent', 'match', 'name']).default('recent'),
  }),
});

export const updateApplicantStatusSchema = z.object({
  body: z.object({
    status: z.enum(HIRER_STATUSES),
    note: z.string().max(1000).optional(),
    rejectionReason: z.string().max(1000).optional(),
  }),
});

export const bulkUpdateApplicantsSchema = z.object({
  body: z.object({
    applicationIds: z.array(z.string().min(1)).min(1).max(200),
    status: z.enum(HIRER_STATUSES),
    note: z.string().max(1000).optional(),
  }),
});

export const updateHirerNotesSchema = z.object({
  body: z.object({
    hirerNotes: z.string().max(4000),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

const requireHirerProfile = async (userId: string) => {
  const profile = await HirerProfile.findOne({ user: userId });
  if (!profile) throw ApiError.forbidden('Set up a company profile first');
  return profile;
};

const requireOwnedJob = async (
  jobId: string,
  hirerProfileId: mongoose.Types.ObjectId,
) => {
  if (!isObjectId(jobId)) throw ApiError.badRequest('Invalid job id');
  const job = await Job.findById(jobId);
  if (!job || !job.isNative) throw ApiError.notFound('Job not found');
  if (!job.hirerProfile || job.hirerProfile.toString() !== hirerProfileId.toString()) {
    throw ApiError.forbidden('You do not have access to this job');
  }
  return job;
};

const sanitiseSeeker = (u: { _id: mongoose.Types.ObjectId; email: string; profile: { fullName: string; avatar?: string; headline?: string; phone?: string; skills: string[]; experienceYears: number; preferredLocations: string[]; resumeUrl?: string } }) => ({
  id: u._id.toString(),
  email: u.email,
  fullName: u.profile.fullName,
  avatar: u.profile.avatar,
  headline: u.profile.headline,
  phone: u.profile.phone,
  skills: u.profile.skills,
  experienceYears: u.profile.experienceYears,
  preferredLocations: u.profile.preferredLocations,
  resumeUrl: u.profile.resumeUrl,
});

const buildApplicantPayload = (a: IAppliedJob, seeker: ReturnType<typeof sanitiseSeeker> | null) => ({
  applicationId: a._id.toString(),
  jobId: a.job.toString(),
  status: a.status,
  matchScore: a.matchScore,
  appliedAt: a.appliedAt,
  applyType: a.applyType,
  source: a.source,
  quickNote: a.quickNote,
  resumeUrlSnapshot: a.resumeUrlSnapshot,
  screeningAnswers: a.screeningAnswers,
  hirerNotes: a.hirerNotes,
  rejectionReason: a.rejectionReason,
  statusHistory: a.statusHistory,
  jobSnapshot: a.jobSnapshot,
  seeker,
});

// Update job counts after a status change. Counts are denormalised on the
// Job document for cheap dashboard reads.
const recomputeShortlistedCount = async (jobId: mongoose.Types.ObjectId) => {
  const c = await AppliedJob.countDocuments({
    job: jobId,
    status: { $in: ['shortlisted', 'interview', 'offer', 'hired'] },
  });
  await Job.updateOne({ _id: jobId }, { $set: { shortlistedCount: c } });
};

// ─────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────

export const listJobApplicants = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const job = await requireOwnedJob(String(req.params.jobId), profile._id);

  const q = req.query as unknown as z.infer<typeof listApplicantsSchema>['query'];
  const filter: Record<string, unknown> = { job: job._id };
  if (q.status !== 'all') filter.status = q.status;
  if (q.minMatch !== undefined) filter.matchScore = { $gte: q.minMatch };

  const skip = (q.page - 1) * q.limit;
  const sort: Record<string, 1 | -1> =
    q.sort === 'match' ? { matchScore: -1, appliedAt: -1 } : { appliedAt: -1 };

  const [items, total] = await Promise.all([
    AppliedJob.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(q.limit)
      .populate({
        path: 'user',
        select: 'email profile.fullName profile.avatar profile.headline profile.phone profile.skills profile.experienceYears profile.preferredLocations profile.resumeUrl',
      }),
    AppliedJob.countDocuments(filter),
  ]);

  let payloads = items.map((a) => {
    const u = a.user as unknown as Parameters<typeof sanitiseSeeker>[0] | null;
    return buildApplicantPayload(a, u ? sanitiseSeeker(u) : null);
  });

  if (q.skill) {
    const needle = q.skill.toLowerCase();
    payloads = payloads.filter((p) =>
      p.seeker?.skills?.some((s) => s.toLowerCase().includes(needle)),
    );
  }

  if (q.sort === 'name') {
    payloads.sort((a, b) =>
      (a.seeker?.fullName ?? '').localeCompare(b.seeker?.fullName ?? ''),
    );
  }

  res.json({
    success: true,
    data: payloads,
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.ceil(total / q.limit) || 1,
      jobTitle: job.title,
    },
  });
});

export const listAllApplicants = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);

  const q = req.query as unknown as z.infer<typeof listApplicantsSchema>['query'];
  const filter: Record<string, unknown> = { hirerProfile: profile._id };
  if (q.status !== 'all') filter.status = q.status;
  if (q.minMatch !== undefined) filter.matchScore = { $gte: q.minMatch };

  const skip = (q.page - 1) * q.limit;
  const sort: Record<string, 1 | -1> =
    q.sort === 'match' ? { matchScore: -1, appliedAt: -1 } : { appliedAt: -1 };

  const [items, total] = await Promise.all([
    AppliedJob.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(q.limit)
      .populate({
        path: 'user',
        select: 'email profile.fullName profile.avatar profile.headline profile.phone profile.skills profile.experienceYears profile.preferredLocations profile.resumeUrl',
      }),
    AppliedJob.countDocuments(filter),
  ]);

  const payloads = items.map((a) => {
    const u = a.user as unknown as Parameters<typeof sanitiseSeeker>[0] | null;
    return buildApplicantPayload(a, u ? sanitiseSeeker(u) : null);
  });

  res.json({
    success: true,
    data: payloads,
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.ceil(total / q.limit) || 1,
    },
  });
});

export const getApplicantDetail = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid application id');

  const application = await AppliedJob.findById(id).populate({
    path: 'user',
    select: 'email profile',
  });
  if (!application) throw ApiError.notFound('Application not found');

  await requireOwnedJob(application.job.toString(), profile._id);

  // First view by hirer auto-promotes status `applied` → `viewed`.
  if (application.status === 'applied') {
    application.status = 'viewed';
    application.statusHistory.push({
      status: 'viewed',
      changedAt: new Date(),
      changedBy: new mongoose.Types.ObjectId(req.user._id!.toString()),
    });
    await application.save();
  }

  const u = application.user as unknown as { _id: mongoose.Types.ObjectId; email: string; profile: IUser['profile'] } | null;

  res.json({
    success: true,
    data: {
      ...buildApplicantPayload(application, u
        ? {
            id: u._id.toString(),
            email: u.email,
            fullName: u.profile.fullName,
            avatar: u.profile.avatar,
            headline: u.profile.headline,
            phone: u.profile.phone,
            skills: u.profile.skills,
            experienceYears: u.profile.experienceYears,
            preferredLocations: u.profile.preferredLocations,
            resumeUrl: u.profile.resumeUrl,
          }
        : null),
      // Extended view — full profile context for the detail screen.
      seekerProfile: u
        ? {
            ...u.profile,
            // Avoid leaking refresh tokens etc. — User.find with the select
            // above already projects only the safe fields.
          }
        : null,
    },
  });
});

const TERMINAL: ApplicationStatus[] = ['hired', 'rejected', 'withdrawn'];

export const updateApplicantStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid application id');

  const application = await AppliedJob.findById(id);
  if (!application) throw ApiError.notFound('Application not found');
  await requireOwnedJob(application.job.toString(), profile._id);

  const { status, note, rejectionReason } = req.body as z.infer<typeof updateApplicantStatusSchema>['body'];

  if (TERMINAL.includes(application.status)) {
    throw ApiError.badRequest(
      `Application is in terminal state (${application.status}); cannot update`,
    );
  }

  application.status = status;
  application.statusHistory.push({
    status,
    changedAt: new Date(),
    changedBy: new mongoose.Types.ObjectId(req.user._id!.toString()),
    note,
  });
  if (status === 'rejected' && rejectionReason) {
    application.rejectionReason = rejectionReason;
  }
  await application.save();
  await recomputeShortlistedCount(application.job);

  // In-app notification for the seeker.
  await Notification.create({
    user: application.user,
    role: 'seeker',
    type: 'application_status',
    title: 'Application status updated',
    body: `Your application for "${application.jobSnapshot.title}" is now ${status}.`,
    data: {
      applicationId: application._id.toString(),
      jobId: application.job.toString(),
      status,
    },
  });

  res.json({
    success: true,
    data: { id: application._id.toString(), status: application.status },
  });
});

export const bulkUpdateApplicants = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const { applicationIds, status, note } = req.body as z.infer<typeof bulkUpdateApplicantsSchema>['body'];

  const ids = applicationIds.filter(isObjectId);
  if (ids.length === 0) throw ApiError.badRequest('No valid application ids');

  // Only update applications whose underlying job belongs to this hirer.
  // Two-step: find owned jobs, then constrain the update to those.
  const ownedJobIds = (
    await Job.find({ hirerProfile: profile._id, isNative: true }).select('_id').lean()
  ).map((j) => j._id);

  const result = await AppliedJob.updateMany(
    {
      _id: { $in: ids },
      job: { $in: ownedJobIds },
      status: { $nin: TERMINAL },
    },
    {
      $set: { status },
      $push: {
        statusHistory: {
          status,
          changedAt: new Date(),
          changedBy: req.user._id,
          note,
        },
      },
    },
  );

  // Refresh shortlist counts on every affected job.
  for (const jobId of ownedJobIds) {
    await recomputeShortlistedCount(jobId);
  }

  res.json({
    success: true,
    data: {
      matched: result.matchedCount,
      modified: result.modifiedCount,
    },
  });
});

/**
 * Returns the applicants for a single job grouped by Kanban column. The
 * Flutter Kanban screen uses this so it doesn't have to slice/dice
 * client-side.
 */
export const getJobKanban = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const job = await requireOwnedJob(String(req.params.jobId), profile._id);

  const items = await AppliedJob.find({ job: job._id })
    .sort({ matchScore: -1, appliedAt: -1 })
    .populate({
      path: 'user',
      select: 'email profile.fullName profile.avatar profile.headline profile.skills profile.experienceYears profile.preferredLocations profile.resumeUrl profile.phone',
    })
    .lean();

  const columns: Record<string, ReturnType<typeof buildApplicantPayload>[]> = {
    applied: [],
    shortlisted: [],
    interview: [],
    offer: [],
    hired: [],
    rejected: [],
    withdrawn: [],
  };
  for (const a of items) {
    const col = columns[a.status as keyof typeof columns];
    if (!col) continue;
    const u = a.user as unknown as Parameters<typeof sanitiseSeeker>[0] | null;
    col.push(buildApplicantPayload(a as unknown as IAppliedJob, u ? sanitiseSeeker(u) : null));
  }

  res.json({
    success: true,
    data: {
      jobId: job._id.toString(),
      jobTitle: job.title,
      columns,
    },
  });
});

export const updateHirerNotes = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid application id');

  const application = await AppliedJob.findById(id);
  if (!application) throw ApiError.notFound('Application not found');
  await requireOwnedJob(application.job.toString(), profile._id);

  const { hirerNotes } = req.body as z.infer<typeof updateHirerNotesSchema>['body'];
  application.hirerNotes = hirerNotes;
  await application.save();

  res.json({ success: true, data: { id: application._id.toString() } });
});
