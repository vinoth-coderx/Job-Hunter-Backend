import { Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Job } from '../models/Job';
import { HirerProfile } from '../models/HirerProfile';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest, JobStatus } from '../types';
import { generateJd } from '../services/ai/jdGenerator.service';
import { extractSkills } from '../services/ai/skillExtractor.service';
import {
  generateScreeningQuestions,
  peekCachedScreeningQuestions,
} from '../services/ai/screeningQuestions.service';
import {
  polishJd,
  peekCachedPolishedJd,
} from '../services/ai/jdPolish.service';
import {
  enforceQuota,
  getQuotaSnapshot,
  refundQuota,
} from '../services/ai/quota.service';
import { getCreditWeight } from '../config/aiCreditWeights';
import { JobModeration } from '../models/JobModeration';
import { writeAudit } from '../services/security/audit.service';

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

const screeningQuestionSchema = z.object({
  question: z.string().min(3).max(500),
  type: z.enum(['text', 'mcq', 'yes_no']),
  options: z.array(z.string().min(1).max(200)).max(10).optional(),
  isRequired: z.boolean().default(false),
});

const baseJobBody = {
  title: z.string().min(2).max(200),
  department: z.string().max(100).optional(),
  description: z.string().min(20).max(20000),
  responsibilities: z.array(z.string().min(1).max(500)).max(20).optional(),
  location: z.string().min(2).max(200),
  jobType: z.enum(['full-time', 'part-time', 'contract', 'internship', 'temporary']),
  remoteType: z.enum(['remote', 'hybrid', 'onsite']),
  openingsCount: z.coerce.number().int().min(1).max(1000).default(1),
  experienceMinYears: z.coerce.number().min(0).max(60).optional(),
  experienceMaxYears: z.coerce.number().min(0).max(60).optional(),
  education: z.string().max(200).optional(),
  skills: z.array(z.string().min(1).max(100)).min(1).max(40),
  niceToHaveSkills: z.array(z.string().min(1).max(100)).max(40).optional(),
  isSalaryVisible: z.boolean().default(true),
  salaryMin: z.coerce.number().min(0).optional(),
  salaryMax: z.coerce.number().min(0).optional(),
  currency: z.string().max(8).default('INR'),
  perks: z.array(z.string().min(1).max(100)).max(30).optional(),
  applyType: z.enum(['easy_apply', 'custom_form']).default('easy_apply'),
  requiredDocuments: z.array(z.string().min(1).max(50)).max(10).optional(),
  screeningQuestions: z.array(screeningQuestionSchema).max(5).optional(),
  applicationDeadline: z.coerce.date().optional(),
};

export const createJobSchema = z.object({
  body: z
    .object({
      ...baseJobBody,
      saveAsDraft: z.boolean().default(false),
    })
    .refine((b) => b.salaryMin === undefined || b.salaryMax === undefined || b.salaryMax >= b.salaryMin, {
      message: 'salaryMax must be >= salaryMin',
      path: ['salaryMax'],
    })
    .refine((b) => b.experienceMinYears === undefined || b.experienceMaxYears === undefined || b.experienceMaxYears >= b.experienceMinYears, {
      message: 'experienceMaxYears must be >= experienceMinYears',
      path: ['experienceMaxYears'],
    }),
});

export const updateJobSchema = z.object({
  body: z
    .object({
      ...Object.fromEntries(
        Object.entries(baseJobBody).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
      ),
    })
    .passthrough(),
});

export const listMyJobsSchema = z.object({
  query: z.object({
    status: z.enum(['draft', 'active', 'paused', 'closed', 'expired', 'all']).default('all'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});

export const updateStatusSchema = z.object({
  body: z.object({
    status: z.enum(['draft', 'active', 'paused', 'closed']),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const requireHirerProfile = async (userId: string) => {
  const profile = await HirerProfile.findOne({ user: userId });
  if (!profile) {
    throw ApiError.forbidden('Set up a company profile before posting jobs');
  }
  return profile;
};

const assertOwnership = (job: { hirerProfile?: mongoose.Types.ObjectId }, profileId: mongoose.Types.ObjectId) => {
  if (!job.hirerProfile || job.hirerProfile.toString() !== profileId.toString()) {
    throw ApiError.forbidden('You do not have access to this job');
  }
};

const isValidObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

// ─────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────

export const createJob = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);

  // Suspended / banned recruiters cannot publish. They can still read
  // their existing jobs (the hirer dashboard endpoints don't go through
  // this guard) but the post path is closed.
  if (profile.approvalStatus === 'suspended' || profile.approvalStatus === 'banned') {
    throw new ApiError(
      403,
      profile.approvalStatus === 'banned'
        ? 'Your hirer account is banned. Contact support.'
        : 'Your hirer account is suspended. Resolve open reports before posting.',
    );
  }

  // Daily posting limit — drawn from HirerProfile.dailyPostLimit (which
  // scales with trust score). External (scraped) jobs don't count.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todaysCount = await Job.countDocuments({
    postedBy: req.user._id,
    isNative: true,
    createdAt: { $gte: today },
  });
  if (todaysCount >= profile.dailyPostLimit) {
    throw new ApiError(
      429,
      `Daily posting limit reached (${profile.dailyPostLimit}). Build trust by verifying your company to unlock more.`,
    );
  }

  const body = req.body as z.infer<typeof createJobSchema>['body'];
  const status: JobStatus = body.saveAsDraft ? 'draft' : 'active';
  const now = new Date();

  const job = await Job.create({
    isNative: true,
    source: 'native',
    hirerProfile: profile._id,
    postedBy: req.user._id,
    title: body.title,
    company: profile.companyName,
    companyLogoUrl: profile.companyLogoUrl,
    department: body.department,
    description: body.description,
    responsibilities: body.responsibilities,
    location: body.location,
    url: `app://jobs/native`, // native jobs apply in-app; resolved by client
    salaryMin: body.salaryMin,
    salaryMax: body.salaryMax,
    currency: body.currency,
    isSalaryVisible: body.isSalaryVisible,
    perks: body.perks,
    jobType: body.jobType,
    remoteType: body.remoteType,
    openingsCount: body.openingsCount,
    experienceMinYears: body.experienceMinYears,
    experienceMaxYears: body.experienceMaxYears,
    education: body.education,
    skills: body.skills.map((s) => s.toLowerCase().trim()),
    niceToHaveSkills: body.niceToHaveSkills?.map((s) => s.toLowerCase().trim()),
    applyType: body.applyType,
    requiredDocuments: body.requiredDocuments,
    screeningQuestions: body.screeningQuestions,
    applicationDeadline: body.applicationDeadline,
    status,
    publishedAt: status === 'active' ? now : undefined,
    postedAt: now,
    fetchedAt: now,
    isActive: status === 'active',
  });

  // Drafts skip moderation — only publish flow goes through the
  // pipeline. When the hirer flips a draft to active later, the status
  // change handler re-runs moderation.
  if (status === 'active') {
    const { moderateJob } = await import('../services/security/moderation.service');
    const result = await moderateJob(job);
    // ModerationDecision includes 'auto_rejected'; the Job.moderation
    // enum exposes 'rejected' to the rest of the app (no need for the
    // app to distinguish auto vs manual rejection — both close the
    // listing).
    job.moderation.status =
      result.decision === 'auto_rejected' ? 'rejected' : result.decision;
    job.moderation.riskScore = result.riskScore;
    job.moderation.flags = result.flags;
    job.moderation.contentHash = result.contentHash;
    job.moderation.lastModelRun = new Date();
    if (result.duplicateOf) {
      job.moderation.duplicateOf = new mongoose.Types.ObjectId(result.duplicateOf);
    }
    job.isPublic = result.decision === 'auto_approved';
    if (result.decision === 'auto_rejected') {
      job.status = 'closed';
      job.isActive = false;
    }
    await job.save();
  }

  res.status(201).json({ success: true, data: job });
});

export const listMyJobs = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);

  const q = req.query as unknown as z.infer<typeof listMyJobsSchema>['query'];
  const filter: Record<string, unknown> = {
    hirerProfile: profile._id,
    isNative: true,
  };
  if (q.status !== 'all') filter.status = q.status;

  const skip = (q.page - 1) * q.limit;
  const [items, total] = await Promise.all([
    Job.find(filter).sort({ createdAt: -1 }).skip(skip).limit(q.limit).lean(),
    Job.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: items,
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.ceil(total / q.limit) || 1,
    },
  });
});

export const getMyJob = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const id = String(req.params.id);
  if (!isValidObjectId(id)) throw ApiError.badRequest('Invalid job id');

  const job = await Job.findById(id);
  if (!job || !job.isNative) throw ApiError.notFound('Job not found');
  assertOwnership(job, profile._id);

  res.json({ success: true, data: job });
});

export const updateJob = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const id = String(req.params.id);
  if (!isValidObjectId(id)) throw ApiError.badRequest('Invalid job id');

  const job = await Job.findById(id);
  if (!job || !job.isNative) throw ApiError.notFound('Job not found');
  assertOwnership(job, profile._id);

  // Closed jobs are immutable.
  if (job.status === 'closed' || job.status === 'expired') {
    throw ApiError.badRequest('Cannot edit a closed job; create a new one instead');
  }

  const body = req.body as Record<string, unknown>;
  // Whitelist updatable fields — never let the client touch ownership,
  // status, counts, postedBy, hirerProfile, isNative.
  const updatable = [
    'title',
    'department',
    'description',
    'responsibilities',
    'location',
    'jobType',
    'remoteType',
    'openingsCount',
    'experienceMinYears',
    'experienceMaxYears',
    'education',
    'skills',
    'niceToHaveSkills',
    'isSalaryVisible',
    'salaryMin',
    'salaryMax',
    'currency',
    'perks',
    'applyType',
    'requiredDocuments',
    'screeningQuestions',
    'applicationDeadline',
  ] as const;

  for (const key of updatable) {
    if (body[key] !== undefined) {
      // Lower-case skill arrays for consistent search.
      if ((key === 'skills' || key === 'niceToHaveSkills') && Array.isArray(body[key])) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (job as any)[key] = (body[key] as string[]).map((s) => s.toLowerCase().trim());
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (job as any)[key] = body[key];
      }
    }
  }

  await job.save();
  res.json({ success: true, data: job });
});

export const updateJobStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const id = String(req.params.id);
  if (!isValidObjectId(id)) throw ApiError.badRequest('Invalid job id');

  const job = await Job.findById(id);
  if (!job || !job.isNative) throw ApiError.notFound('Job not found');
  assertOwnership(job, profile._id);

  const { status } = req.body as { status: JobStatus };

  // Legal transitions:
  //   draft  → active | closed
  //   active → paused | closed
  //   paused → active | closed
  //   closed → (terminal)
  const legal: Record<JobStatus, JobStatus[]> = {
    draft: ['active', 'closed'],
    active: ['paused', 'closed'],
    paused: ['active', 'closed'],
    closed: [],
    expired: [],
  };
  if (!legal[job.status].includes(status)) {
    throw ApiError.badRequest(`Cannot move job from ${job.status} → ${status}`);
  }

  job.status = status;
  job.isActive = status === 'active';
  if (status === 'active' && !job.publishedAt) job.publishedAt = new Date();
  if (status === 'closed') job.closedAt = new Date();

  await job.save();
  res.json({ success: true, data: { id: job._id, status: job.status } });
});

export const deleteJob = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const id = String(req.params.id);
  if (!isValidObjectId(id)) throw ApiError.badRequest('Invalid job id');

  const job = await Job.findById(id);
  if (!job || !job.isNative) throw ApiError.notFound('Job not found');
  assertOwnership(job, profile._id);

  // Only drafts can be hard-deleted. Anything that's been published has
  // application history attached — close it instead.
  if (job.status !== 'draft') {
    throw ApiError.badRequest('Only draft jobs can be deleted; close published jobs instead');
  }

  await job.deleteOne();
  res.json({ success: true, message: 'Draft deleted' });
});

export const getJobAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);
  const id = String(req.params.id);
  if (!isValidObjectId(id)) throw ApiError.badRequest('Invalid job id');

  const job = await Job.findById(id).lean();
  if (!job || !job.isNative) throw ApiError.notFound('Job not found');
  if (!job.hirerProfile || job.hirerProfile.toString() !== profile._id.toString()) {
    throw ApiError.forbidden('You do not have access to this job');
  }

  res.json({
    success: true,
    data: {
      jobId: job._id,
      title: job.title,
      status: job.status,
      viewsCount: job.viewsCount,
      applicationsCount: job.applicationsCount,
      shortlistedCount: job.shortlistedCount,
      shortlistRate:
        job.applicationsCount > 0
          ? Math.round((job.shortlistedCount / job.applicationsCount) * 100)
          : 0,
      publishedAt: job.publishedAt,
      applicationDeadline: job.applicationDeadline,
      isBoosted: job.isBoosted,
    },
  });
});

export const generateJdSchema = z.object({
  body: z.object({
    role: z.string().min(2).max(120),
    experienceMinYears: z.coerce.number().min(0).max(60).optional(),
    experienceMaxYears: z.coerce.number().min(0).max(60).optional(),
    location: z.string().max(120).optional(),
    remoteType: z.enum(['onsite', 'hybrid', 'remote']).optional(),
    jobType: z.string().max(40).optional(),
    keywords: z.array(z.string().min(1).max(40)).max(8).optional(),
    toneHint: z.enum(['professional', 'casual', 'startup']).optional(),
  }),
});

/**
 * Generate a JD draft from a role + few keywords. The hirer always gets to
 * edit before posting — this is a starting point, not the final post. One
 * AI quota slot, refunded on failure.
 */
export const generateJdEndpoint = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const userId = String(req.user._id);

  const profile = await HirerProfile.findOne({ user: userId }).select('companyName');
  if (!profile) throw ApiError.forbidden('Hirer profile required to generate JD');

  const body = req.body as z.infer<typeof generateJdSchema>['body'];
  const weight = getCreditWeight('jd_generator');
  const quota = await enforceQuota(userId, weight);

  let jd;
  try {
    jd = await generateJd({ ...body, companyName: profile.companyName });
  } catch (err) {
    await refundQuota(userId, weight);
    throw err;
  }

  if (!jd) {
    await refundQuota(userId, weight);
    res.json({ success: true, data: null, message: 'AI unavailable', quota });
    return;
  }

  res.json({ success: true, data: jd, quota });
});

export const extractSkillsSchema = z.object({
  body: z.object({
    text: z.string().min(30).max(8000),
  }),
});

/**
 * Extract a normalised skill list from a JD draft. Used by the hirer
 * post-job flow's "Suggest skills" affordance — surfaces the implicit
 * skill requirements the AI reads in the JD body so the hirer can
 * accept them as the listing's structured `skills` array.
 *
 * Routed through Groq (cheap, fast). Doesn't burn quota — the call is
 * short and cached for 7d per identical text.
 */
export const extractSkillsEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await requireHirerProfile(req.user.id);

    const { text } = req.body as z.infer<typeof extractSkillsSchema>['body'];
    const result = await extractSkills(text, { userId: String(req.user._id) });
    res.json({ success: true, data: result });
  },
);

export const submitModerationAppealSchema = z.object({
  body: z.object({
    reason: z.string().min(20).max(2000),
  }),
});

/**
 * Hirer-side appeal against a moderation rejection. Mutates the LATEST
 * `JobModeration` row for this job in place — only the most recent
 * decision is appealable, and only when:
 *   - Decision is `auto_rejected` OR an admin override marked it `rejected`
 *   - There isn't already a pending appeal (one open appeal per row)
 *
 * The job document itself stays in its current state (rejected / closed)
 * until the admin resolves the appeal.
 */
export const submitModerationAppeal = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);

    const id = String(req.params.id);
    if (!isValidObjectId(id)) throw ApiError.badRequest('Invalid job id');

    const job = await Job.findById(id);
    if (!job || !job.isNative) throw ApiError.notFound('Job not found');
    assertOwnership(job, profile._id);

    const moderation = await JobModeration.findOne({ job: job._id }).sort({
      createdAt: -1,
    });
    if (!moderation) {
      throw ApiError.badRequest('No moderation record exists for this job');
    }

    const isRejected =
      moderation.decision === 'auto_rejected' ||
      moderation.overrideDecision === 'rejected';
    if (!isRejected) {
      throw ApiError.badRequest('Only rejected jobs can be appealed');
    }

    if (moderation.appeal && moderation.appeal.status === 'pending') {
      throw ApiError.badRequest(
        'An appeal is already pending review for this job',
      );
    }

    const { reason } = req.body as z.infer<
      typeof submitModerationAppealSchema
    >['body'];

    // `req.user._id` is typed optional because guest sessions don't have
    // a DB record. We've already guarded `req.user` above, and the hirer
    // profile lookup requires a real user, so the bang is safe.
    const userId = req.user._id!;
    const submittedAt = new Date();
    moderation.appeal = {
      submittedBy: userId,
      reason,
      submittedAt,
      status: 'pending',
    };
    await moderation.save();

    await writeAudit({
      actor: { id: userId, email: req.user.email },
      actorType: 'hirer',
      category: 'job_moderation',
      action: 'moderation:appeal_submitted',
      target: { type: 'Job', id: job._id, label: job.title },
      metadata: { reason: reason.slice(0, 200) },
      req,
    });

    res.json({
      success: true,
      data: {
        jobId: job._id.toString(),
        appealStatus: 'pending',
        submittedAt,
      },
    });
  },
);

export const generateScreeningQuestionsSchema = z.object({
  body: z.object({
    title: z.string().min(3).max(200),
    description: z.string().min(20).max(20000),
    skills: z.array(z.string().min(1).max(100)).max(40).default([]),
  }),
});

/**
 * AI screening-question generator. Hirer hits this from the post-job
 * editor; the response is 3-5 ready-to-edit questions in the same shape
 * `IScreeningQuestion` uses, so the editor drops them straight into its
 * working list. The hirer gets to keep / edit / delete each one before
 * the job is saved.
 *
 * Cache pre-check by hash(title + skills + description prefix) — same
 * draft re-asked is free of quota.
 */
export const generateScreeningQuestionsEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const { title, description, skills } = req.body as z.infer<
      typeof generateScreeningQuestionsSchema
    >['body'];

    const cached = await peekCachedScreeningQuestions(
      title,
      description,
      skills,
    );
    let quota = await getQuotaSnapshot(userId);
    if (cached) {
      res.json({
        success: true,
        data: { questions: cached, usedAi: true, cached: true },
        quota,
      });
      return;
    }

    const weight = getCreditWeight('screening_questions');
    if (weight > 0) quota = await enforceQuota(userId, weight);

    let result;
    try {
      result = await generateScreeningQuestions({
        title,
        description,
        skills,
        userId,
      });
    } catch (err) {
      if (weight > 0) await refundQuota(userId, weight);
      throw err;
    }
    // Refund when we got the heuristic fallback so the hirer isn't
    // charged for "no AI ran".
    if (weight > 0 && !result.usedAi) {
      await refundQuota(userId, weight);
    }

    res.json({
      success: true,
      data: result,
      quota,
    });
  },
);

export const polishJdSchema = z.object({
  body: z.object({
    title: z.string().min(3).max(200),
    description: z.string().min(50).max(20000),
  }),
});

/**
 * AI polish for the hirer's JD draft. Returns the rewritten body plus
 * a list of changes applied. Cache pre-check by hash(title +
 * description) so re-clicking on an unchanged draft is free.
 */
export const polishJdEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const { title, description } = req.body as z.infer<
      typeof polishJdSchema
    >['body'];

    const cached = await peekCachedPolishedJd(title, description);
    let quota = await getQuotaSnapshot(userId);
    if (cached) {
      res.json({ success: true, data: cached, quota });
      return;
    }

    const weight = getCreditWeight('jd_polish');
    if (weight > 0) quota = await enforceQuota(userId, weight);

    let result;
    try {
      result = await polishJd({ title, description, userId });
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
