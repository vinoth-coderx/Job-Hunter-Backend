import { Response } from 'express';
import { z } from 'zod';
import { Job } from '../models/Job';
import { AppliedJob } from '../models/AppliedJob';
import { Notification } from '../models/Notification';
import { HirerProfile } from '../models/HirerProfile';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { heuristicMatch } from '../services/ai/matcher.service';
import { User } from '../models/User';

export const applySchema = z.object({
  body: z.object({
    jobId: z.string().min(1),
    notes: z.string().max(2000).optional(),
  }),
});

export const quickApplySchema = z.object({
  body: z.object({
    jobId: z.string().min(1),
    quickNote: z.string().max(500).optional(),
    screeningAnswers: z
      .array(
        z.object({
          question: z.string().min(1).max(500),
          answer: z.string().min(1).max(2000),
        }),
      )
      .max(10)
      .optional(),
  }),
});

export const updateAppliedSchema = z.object({
  body: z.object({
    // Seekers can only withdraw their own application or update notes/follow-up.
    // Other statuses are hirer-controlled.
    status: z.enum(['withdrawn']).optional(),
    notes: z.string().max(2000).optional(),
    followUpDate: z.string().datetime().optional(),
  }),
});

export const applyToJob = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { jobId, notes } = req.body;

  const job = await Job.findById(jobId);
  if (!job) throw ApiError.notFound('Job not found');

  const exists = await AppliedJob.findOne({ user: req.user._id, job: jobId });
  if (exists) throw ApiError.conflict('You have already applied to this job');

  const user = await User.findById(req.user._id);
  const score = user ? heuristicMatch(user, job).score : undefined;

  const applied = await AppliedJob.create({
    user: req.user._id,
    job: job._id,
    jobSnapshot: {
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,
    },
    notes,
    matchScore: score,
    status: 'applied',
  });

  res.status(201).json({ success: true, message: 'Marked as applied', data: applied });
});

/**
 * Native one-click apply. Validates the job is native + active, that the
 * seeker has a resume, that screening answers cover required questions,
 * then atomically creates the application + bumps the job's
 * applicationsCount + sends an in-app notification to the hirer.
 */
export const quickApply = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { jobId, quickNote, screeningAnswers } = req.body as z.infer<
    typeof quickApplySchema
  >['body'];

  const job = await Job.findById(jobId);
  if (!job) throw ApiError.notFound('Job not found');
  if (!job.isNative) {
    throw ApiError.badRequest('This job uses external apply; use the WebView flow');
  }
  if (job.status !== 'active' || !job.isActive) {
    throw ApiError.badRequest(`Job is not accepting applications (status: ${job.status})`);
  }
  if (job.applicationDeadline && job.applicationDeadline < new Date()) {
    throw ApiError.badRequest('Application deadline has passed');
  }

  const exists = await AppliedJob.findOne({ user: req.user._id, job: job._id });
  if (exists) throw ApiError.conflict('You have already applied to this job');

  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound('User not found');

  // Resume gate — required for one-click. Custom-form jobs may relax this
  // later; for Phase 1 we always require a resume.
  if (!user.profile.resumeUrl && !user.profile.resumeFile) {
    throw ApiError.badRequest('Upload a resume on your profile before applying');
  }

  // Validate required screening questions are answered.
  if (job.screeningQuestions && job.screeningQuestions.length > 0) {
    const requiredQs = job.screeningQuestions.filter((q) => q.isRequired);
    const provided = new Map(
      (screeningAnswers ?? []).map((a) => [a.question.trim(), a.answer.trim()]),
    );
    for (const q of requiredQs) {
      const a = provided.get(q.question.trim());
      if (!a || a.length === 0) {
        throw ApiError.badRequest(`Required question not answered: "${q.question}"`);
      }
    }
  }

  const score = heuristicMatch(user, job).score;

  const applied = await AppliedJob.create({
    user: req.user._id,
    job: job._id,
    hirerProfile: job.hirerProfile,
    jobSnapshot: {
      title: job.title,
      company: job.company,
      location: job.location,
      url: job.url,
    },
    applyType: 'one_click',
    source: 'native',
    resumeUrlSnapshot: user.profile.resumeUrl,
    quickNote,
    screeningAnswers,
    matchScore: score,
    status: 'applied',
    statusHistory: [{ status: 'applied', changedAt: new Date(), changedBy: req.user._id }],
  });

  // Increment job-level counters atomically.
  await Job.updateOne({ _id: job._id }, { $inc: { applicationsCount: 1 } });

  // Notify the hirer (if any) — best-effort, never fails the apply.
  if (job.hirerProfile) {
    const hirer = await HirerProfile.findById(job.hirerProfile).select('user').lean();
    if (hirer?.user) {
      try {
        await Notification.create({
          user: hirer.user,
          role: 'hirer',
          type: 'new_applicant',
          title: 'New applicant',
          body: `${user.profile.fullName} applied to "${job.title}"`,
          data: {
            applicationId: applied._id.toString(),
            jobId: job._id.toString(),
            matchScore: score,
          },
        });
      } catch {
        // best-effort
      }
    }
  }

  res.status(201).json({ success: true, message: 'Application sent', data: applied });
});

export const listApplied = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20);
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = { user: req.user._id };
  if (status) filter.status = status;

  const [items, total] = await Promise.all([
    AppliedJob.find(filter).sort({ appliedAt: -1 }).skip(skip).limit(limit).populate('job'),
    AppliedJob.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: items,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

export const updateApplied = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { id } = req.params;

  const updated = await AppliedJob.findOneAndUpdate(
    { _id: id, user: req.user._id },
    { $set: req.body },
    { new: true, runValidators: true },
  );
  if (!updated) throw ApiError.notFound('Applied job not found');

  res.json({ success: true, data: updated });
});

export const deleteApplied = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { id } = req.params;
  const deleted = await AppliedJob.findOneAndDelete({ _id: id, user: req.user._id });
  if (!deleted) throw ApiError.notFound('Applied job not found');
  res.json({ success: true, message: 'Removed' });
});

export const appliedStats = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const stats = await AppliedJob.aggregate([
    { $match: { user: req.user._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const total = await AppliedJob.countDocuments({ user: req.user._id });
  res.json({ success: true, data: { total, byStatus: stats } });
});
