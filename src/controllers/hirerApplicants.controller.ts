import { Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { AppliedJob, ApplicationStatus, IAppliedJob } from '../models/AppliedJob';
import { Job } from '../models/Job';
import { HirerProfile } from '../models/HirerProfile';
import { IUser } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { notifyUser } from '../services/notification/notify.service';
import { emitToUser } from '../services/chat/socket';
import { ResumeAccessLog } from '../models/ResumeAccessLog';
import { User } from '../models/User';
import { signedDeliveryUrl } from '../config/cloudinary';
import { getCreditWeight } from '../config/aiCreditWeights';
import {
  peekCachedRanking,
  rankApplicants,
  type RankableApplicant,
} from '../services/ai/applicantRanker.service';
import {
  peekCachedSuggestions,
  suggestCandidates,
  type SuggestableCandidate,
} from '../services/ai/candidateSuggester.service';
import {
  draftRecruiterOutreach,
  peekCachedOutreach,
} from '../services/ai/recruiterOutreach.service';
import {
  peekCachedTldr,
  summariseResume,
} from '../services/ai/resumeTldr.service';
import {
  enforceQuota,
  getQuotaSnapshot,
  refundQuota,
} from '../services/ai/quota.service';

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

export const rankApplicantsSchema = z.object({
  body: z
    .object({
      // Optional cap. Backend hard-cap is 25 to keep one prompt under
      // ~12k tokens; if the hirer has 200 applications they'll page.
      limit: z.coerce.number().int().min(1).max(25).optional(),
    })
    .partial(),
});

export const candidateSuggestionsSchema = z.object({
  body: z
    .object({
      /** Max suggestions to return; backend hard-cap is 20. */
      limit: z.coerce.number().int().min(1).max(20).optional(),
      /** Cap on the candidate pool we score against; backend max 50. */
      poolSize: z.coerce.number().int().min(1).max(50).optional(),
    })
    .partial(),
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
  jobId: a.job!.toString(),
  status: a.status,
  matchScore: a.matchScore,
  aiRanking: a.aiRanking
    ? {
        score: a.aiRanking.score,
        rank: a.aiRanking.rank,
        summary: a.aiRanking.summary,
        strengths: a.aiRanking.strengths,
        concerns: a.aiRanking.concerns,
        rankedAt: a.aiRanking.rankedAt,
      }
    : undefined,
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

  await requireOwnedJob(application.job!.toString(), profile._id);

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

  // Resume privacy gate. The seeker can hide contact details until they
  // are shortlisted; mask phone + email until the application has been
  // moved off `applied`/`viewed`. The resumeUrl itself is gated below
  // by allowResumeDownload on the dedicated download endpoint, not here.
  const seekerDoc = u
    ? await User.findById(u._id).select('privacy')
    : null;
  const privacy = seekerDoc?.privacy;
  const showContact =
    !privacy?.hideContactUntilShortlisted ||
    ['shortlisted', 'interview', 'offer', 'hired'].includes(
      application.status,
    );

  // Append-only access log: every hirer view of an applicant's resume
  // is preserved here. The seeker sees this list under
  // Settings → Security → Resume access log.
  if (u && u.profile.resumeUrl) {
    ResumeAccessLog.create({
      resumeOwner: u._id,
      accessor: req.user._id,
      accessorRole: 'hirer',
      company: profile.companyName,
      action: 'view',
      application: application._id,
      ip: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    }).catch(() => undefined);
  }

  res.json({
    success: true,
    data: {
      ...buildApplicantPayload(application, u
        ? {
            id: u._id.toString(),
            email: showContact ? u.email : 'hidden until shortlisted',
            fullName: u.profile.fullName,
            avatar: u.profile.avatar,
            headline: u.profile.headline,
            phone: showContact ? u.profile.phone : undefined,
            skills: u.profile.skills,
            experienceYears: u.profile.experienceYears,
            preferredLocations: u.profile.preferredLocations,
            resumeUrl: u.profile.resumeUrl,
          }
        : null),
      seekerProfile: u
        ? {
            ...u.profile,
            phone: showContact ? u.profile.phone : undefined,
          }
        : null,
      seekerPrivacy: {
        hideContactUntilShortlisted:
          privacy?.hideContactUntilShortlisted ?? false,
        allowResumeDownload: privacy?.allowResumeDownload ?? true,
        contactRevealed: showContact,
      },
    },
  });
});

const formatFromMime = (mime?: string): string => {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/msword') return 'doc';
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  return 'bin';
};

/// Hirer-facing applicant resume download. Gated on the seeker's
/// `privacy.allowResumeDownload` flag — when off, the hirer can still
/// view the resume in-app but can't pull a signed URL. Every successful
/// call writes a `download` row to ResumeAccessLog so the seeker can
/// see who fetched a copy.
export const downloadApplicantResume = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isObjectId(id)) throw ApiError.badRequest('Invalid application id');

    const application = await AppliedJob.findById(id);
    if (!application) throw ApiError.notFound('Application not found');
    await requireOwnedJob(application.job!.toString(), profile._id);

    const seeker = await User.findById(application.user).select(
      'privacy profile.resumeFile profile.resumeUrl',
    );
    if (!seeker?.profile?.resumeFile?.publicId) {
      throw ApiError.notFound('Applicant has no resume on file');
    }
    if (seeker.privacy?.allowResumeDownload === false) {
      throw ApiError.forbidden(
        'Applicant has disabled resume downloads. View only.',
      );
    }

    const file = seeker.profile.resumeFile;
    const signed = signedDeliveryUrl(file.publicId!, {
      resourceType: 'raw',
      type: 'authenticated',
      format: formatFromMime(file.mimeType),
      expiresInSec: 300,
      attachmentFilename: file.originalName,
    });

    await ResumeAccessLog.create({
      resumeOwner: seeker._id,
      accessor: req.user._id,
      accessorRole: 'hirer',
      company: profile.companyName,
      action: 'download',
      application: application._id,
      ip: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });

    res.redirect(302, signed);
  },
);

const TERMINAL: ApplicationStatus[] = ['hired', 'rejected', 'withdrawn'];

export const updateApplicantStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid application id');

  const application = await AppliedJob.findById(id);
  if (!application) throw ApiError.notFound('Application not found');
  await requireOwnedJob(application.job!.toString(), profile._id);

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
  await recomputeShortlistedCount(application.job!);

  // In-app notification + live banner for the seeker.
  await notifyUser({
    user: application.user,
    role: 'seeker',
    type: 'application_status',
    title: 'Application status updated',
    body: `Your application for "${application.jobSnapshot.title}" is now ${status}.`,
    data: {
      applicationId: application._id.toString(),
      jobId: application.job!.toString(),
      status,
    },
  });

  // Dedicated event so the seeker's applications screen can update the
  // single row without a full refetch.
  emitToUser(application.user.toString(), 'application:status', {
    applicationId: application._id.toString(),
    jobId: application.job!.toString(),
    status,
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
  await requireOwnedJob(application.job!.toString(), profile._id);

  const { hirerNotes } = req.body as z.infer<typeof updateHirerNotesSchema>['body'];
  application.hirerNotes = hirerNotes;
  await application.save();

  res.json({ success: true, data: { id: application._id.toString() } });
});

/**
 * AI-rank the applicants for a job. Top N (default 25, hard-capped at 25
 * to keep one prompt under the model's effective input window). One quota
 * slot per fresh ranking; cache hits (same job + same applicant set,
 * unchanged job description) are free.
 *
 * Returns rankings sorted by aiScore desc with one-line summary +
 * strengths/concerns each. Falls back to heuristic skill-overlap ranking
 * when no AI provider is configured.
 */
export const rankJobApplicants = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const profile = await requireHirerProfile(req.user.id);
    const job = await requireOwnedJob(String(req.params.jobId), profile._id);

    const { limit } = req.body as z.infer<typeof rankApplicantsSchema>['body'];
    const cap = Math.max(1, Math.min(25, limit ?? 25));

    // Pull the most recent N applications. We sort by appliedAt desc so
    // older applications drop off first when the cap binds — fits the
    // "rank my latest pipeline" mental model.
    const apps = await AppliedJob.find({ job: job._id })
      .sort({ appliedAt: -1 })
      .limit(cap)
      .populate({
        path: 'user',
        select:
          'profile.fullName profile.headline profile.experienceYears profile.skills profile.resumeText',
      });

    if (apps.length === 0) {
      const quota = await getQuotaSnapshot(userId);
      res.json({
        success: true,
        data: { rankings: [], usedAi: false, cached: false },
        quota,
      });
      return;
    }

    const rankable: RankableApplicant[] = apps.map((a) => {
      const u = a.user as unknown as IUser | null;
      return {
        applicationId: a._id.toString(),
        fullName: u?.profile?.fullName ?? 'Candidate',
        headline: u?.profile?.headline,
        experienceYears: u?.profile?.experienceYears,
        skills: u?.profile?.skills ?? [],
        resumeText: u?.profile?.resumeText,
        heuristicMatch: a.matchScore,
      };
    });

    const ids = rankable.map((r) => r.applicationId);
    const cached = await peekCachedRanking(job._id.toString(), job.updatedAt, ids);
    let quota = await getQuotaSnapshot(userId);
    if (cached) {
      res.json({
        success: true,
        data: { rankings: cached, usedAi: true, cached: true },
        quota,
      });
      return;
    }

    const weight = getCreditWeight('applicant_rank');
    quota = await enforceQuota(userId, weight);
    let result;
    try {
      result = await rankApplicants({ job, applicants: rankable, userId });
    } catch (err) {
      await refundQuota(userId, weight);
      throw err;
    }
    if (!result.usedAi) await refundQuota(userId, weight);

    // Persist the ranking onto each AppliedJob so the detail screen can
    // surface strengths/concerns long after the Redis cache expires.
    // bulkWrite is one round-trip regardless of batch size.
    if (result.rankings.length > 0) {
      const now = new Date();
      const ops = result.rankings.map((r) => ({
        updateOne: {
          filter: { _id: r.applicationId },
          update: {
            $set: {
              aiRanking: {
                score: r.aiScore,
                rank: r.rank,
                summary: r.summary,
                strengths: r.strengths,
                concerns: r.concerns,
                rankedAt: now,
              },
            },
          },
        },
      }));
      await AppliedJob.bulkWrite(ops, { ordered: false });
    }

    res.json({
      success: true,
      data: {
        rankings: result.rankings,
        usedAi: result.usedAi,
        cached: result.cached,
      },
      quota,
    });
  },
);

/**
 * AI candidate suggestions for a job. Pulls "silver medalist" candidates
 * from THIS hirer's past applicant pool — i.e. users who have applied
 * to one of the hirer's other jobs (so the hirer already has lawful
 * access to their resume) but haven't applied to THIS job yet. Ranks
 * them against the new job and surfaces the top fits with strengths +
 * concerns so the hirer can proactively reach out.
 *
 * Privacy: the pool is gated to the hirer's existing applicant graph;
 * we never surface users they haven't already received an application
 * from. This keeps the feature non-creepy and consistent with the
 * platform's existing trust model.
 *
 * Cost: one `candidate_suggest` quota slot per fresh ranking (weight
 * lives in aiCreditWeights). Same job + same pool → cache hit, free.
 */
export const suggestJobCandidates = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const profile = await requireHirerProfile(req.user.id);
    const job = await requireOwnedJob(String(req.params.jobId), profile._id);

    const { limit, poolSize } = req.body as z.infer<
      typeof candidateSuggestionsSchema
    >['body'];
    const finalLimit = Math.max(1, Math.min(20, limit ?? 10));
    const finalPool = Math.max(1, Math.min(50, poolSize ?? 50));

    // Exclude users who have already applied to THIS job — suggesting
    // them would be redundant; they're already on the applicants screen.
    const existingApplicants = await AppliedJob.distinct('user', {
      job: job._id,
    });

    // Pool = distinct users from this hirer's other jobs, excluding
    // rejected/withdrawn (hirer didn't want them) and the THIS-job set.
    const candidateUserIds = await AppliedJob.aggregate<{
      _id: mongoose.Types.ObjectId;
      lastSeenAt: Date;
    }>([
      {
        $match: {
          hirerProfile: profile._id,
          job: { $ne: job._id },
          status: { $nin: ['rejected', 'withdrawn'] },
          user: { $nin: existingApplicants },
        },
      },
      {
        $group: {
          _id: '$user',
          lastSeenAt: { $max: '$appliedAt' },
        },
      },
      { $sort: { lastSeenAt: -1 } },
      { $limit: finalPool },
    ]);

    if (candidateUserIds.length === 0) {
      const quota = await getQuotaSnapshot(userId);
      res.json({
        success: true,
        data: {
          suggestions: [],
          usedAi: false,
          cached: false,
          poolSize: 0,
        },
        quota,
      });
      return;
    }

    const users = await User.find({
      _id: { $in: candidateUserIds.map((c) => c._id) },
    }).select(
      'profile.fullName profile.headline profile.experienceYears profile.skills profile.resumeText profile.avatar',
    );

    const lastSeenMap = new Map<string, Date>(
      candidateUserIds.map((c) => [c._id.toString(), c.lastSeenAt]),
    );

    const pool: SuggestableCandidate[] = users.map((u) => ({
      userId: u._id.toString(),
      fullName: u.profile?.fullName ?? 'Candidate',
      headline: u.profile?.headline,
      experienceYears: u.profile?.experienceYears,
      skills: u.profile?.skills ?? [],
      resumeText: u.profile?.resumeText,
      lastSeenAt: lastSeenMap.get(u._id.toString())?.toISOString(),
    }));

    // Cheap cache probe before debiting quota — same job + same pool
    // means we already paid for this ranking earlier.
    const ids = pool.map((c) => c.userId);
    const cached = await peekCachedSuggestions(
      job._id.toString(),
      job.updatedAt,
      ids,
    );
    let quota = await getQuotaSnapshot(userId);
    if (cached) {
      const trimmed = cached.slice(0, finalLimit);
      res.json({
        success: true,
        data: {
          suggestions: decorateWithProfile(trimmed, users, lastSeenMap),
          usedAi: true,
          cached: true,
          poolSize: pool.length,
        },
        quota,
      });
      return;
    }

    const weight = getCreditWeight('candidate_suggest');
    quota = await enforceQuota(userId, weight);
    let result;
    try {
      result = await suggestCandidates({
        job,
        pool,
        userId,
        limit: finalLimit,
      });
    } catch (err) {
      await refundQuota(userId, weight);
      throw err;
    }
    if (!result.usedAi) await refundQuota(userId, weight);

    res.json({
      success: true,
      data: {
        suggestions: decorateWithProfile(
          result.suggestions,
          users,
          lastSeenMap,
        ),
        usedAi: result.usedAi,
        cached: result.cached,
        poolSize: result.poolSize,
      },
      quota,
    });
  },
);

/**
 * Decorate the lean AI output with profile fields the UI needs. Keeps
 * the candidate-suggester service free of frontend concerns while still
 * giving the hirer screen everything it needs to render a card without
 * a second round-trip per user.
 */
const decorateWithProfile = (
  suggestions: { userId: string; score: number; rank: number; summary: string; strengths: string[]; concerns: string[] }[],
  users: Array<{
    _id: mongoose.Types.ObjectId;
    profile?: {
      fullName?: string;
      headline?: string;
      avatar?: string;
      experienceYears?: number;
      skills?: string[];
    };
  }>,
  lastSeenMap: Map<string, Date>,
) => {
  const byId = new Map(users.map((u) => [u._id.toString(), u]));
  return suggestions.map((s) => {
    const u = byId.get(s.userId);
    return {
      userId: s.userId,
      score: s.score,
      rank: s.rank,
      summary: s.summary,
      strengths: s.strengths,
      concerns: s.concerns,
      fullName: u?.profile?.fullName ?? 'Candidate',
      headline: u?.profile?.headline,
      avatar: u?.profile?.avatar,
      experienceYears: u?.profile?.experienceYears,
      topSkills: (u?.profile?.skills ?? []).slice(0, 6),
      lastSeenAt: lastSeenMap.get(s.userId)?.toISOString(),
    };
  });
};

/**
 * AI-drafted recruiter outreach for a (job, candidate) pair. Returns
 * 2-3 short opener variants the hirer can paste into the in-app chat.
 * Cache pre-check by (jobId + candidateId + jobUpdatedAt) so re-opening
 * the same candidate card costs no quota.
 */
export const draftCandidateOutreach = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const profile = await requireHirerProfile(req.user.id);
    const job = await requireOwnedJob(String(req.params.jobId), profile._id);

    const candidateId = String(req.params.userId);
    if (!isObjectId(candidateId)) {
      throw ApiError.badRequest('Invalid candidate id');
    }

    const candidate = await User.findById(candidateId).select(
      'profile.fullName profile.headline profile.experienceYears profile.skills',
    );
    if (!candidate) throw ApiError.notFound('Candidate not found');

    const cached = await peekCachedOutreach(
      job._id.toString(),
      candidate._id.toString(),
      job.updatedAt,
    );
    let quota = await getQuotaSnapshot(userId);
    if (cached) {
      res.json({
        success: true,
        data: { drafts: cached, usedAi: true, cached: true },
        quota,
      });
      return;
    }

    const weight = getCreditWeight('recruiter_outreach');
    if (weight > 0) quota = await enforceQuota(userId, weight);

    let result;
    try {
      result = await draftRecruiterOutreach({
        job,
        candidate,
        userId,
      });
    } catch (err) {
      if (weight > 0) await refundQuota(userId, weight);
      throw err;
    }
    if (weight > 0 && !result.usedAi) {
      await refundQuota(userId, weight);
    }

    res.json({ success: true, data: result, quota });
  },
);

/**
 * AI 2-line TL;DR of the applicant's resume. Cached by hash(resumeText)
 * so the same resume re-opened across hirers is free of quota — useful
 * when a strong candidate applies to multiple roles. Cache pre-check
 * skips the quota debit entirely.
 */
export const getApplicantResumeTldr = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const profile = await requireHirerProfile(req.user.id);
    const id = String(req.params.id);
    if (!isObjectId(id)) throw ApiError.badRequest('Invalid application id');

    const application = await AppliedJob.findById(id).populate({
      path: 'user',
      select: 'profile.resumeText',
    });
    if (!application) throw ApiError.notFound('Application not found');
    await requireOwnedJob(application.job!.toString(), profile._id);

    const seeker = application.user as unknown as
      | { profile?: { resumeText?: string } }
      | null;
    const resumeText = (seeker?.profile?.resumeText || '').trim();
    if (resumeText.length < 100) {
      const quota = await getQuotaSnapshot(userId);
      res.json({
        success: true,
        data: {
          summary: 'No resume text on file for this applicant.',
          strengths: [],
          yearsOfExperience: null,
          topRoles: [],
          usedAi: false,
          cached: false,
        },
        quota,
      });
      return;
    }

    const cached = await peekCachedTldr(resumeText);
    let quota = await getQuotaSnapshot(userId);
    if (cached) {
      res.json({ success: true, data: cached, quota });
      return;
    }

    const weight = getCreditWeight('resume_tldr');
    if (weight > 0) quota = await enforceQuota(userId, weight);

    let result;
    try {
      result = await summariseResume({ resumeText, userId });
    } catch (err) {
      if (weight > 0) await refundQuota(userId, weight);
      throw err;
    }
    if (weight > 0 && !result.usedAi) {
      await refundQuota(userId, weight);
    }

    res.json({ success: true, data: result, quota });
  },
);
