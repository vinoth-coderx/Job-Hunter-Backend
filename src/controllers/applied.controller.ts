import { Response } from 'express';
import { z } from 'zod';
import { Job } from '../models/Job';
import { AppliedJob } from '../models/AppliedJob';
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

export const updateAppliedSchema = z.object({
  body: z.object({
    status: z.enum(['applied', 'viewed', 'interview', 'offer', 'rejected', 'withdrawn']).optional(),
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
