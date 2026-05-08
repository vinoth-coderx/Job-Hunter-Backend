import { Response } from 'express';
import mongoose from 'mongoose';
import { SavedJob } from '../models/SavedJob';
import { Job } from '../models/Job';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

export const listSavedJobs = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const pageRaw = typeof req.query.page === 'string' ? Number(req.query.page) : NaN;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = Math.min(100, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    SavedJob.find({ user: req.user._id })
      .sort({ savedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('job')
      .lean(),
    SavedJob.countDocuments({ user: req.user._id }),
  ]);

  // Drop entries whose underlying job is gone (best-effort cleanup is left
  // to a periodic job; here we just hide them).
  const jobs = items.map((s) => s.job).filter((j) => j);

  res.json({
    success: true,
    data: jobs,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
});

export const listSavedJobIds = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const items = await SavedJob.find({ user: req.user._id }).select('job').lean();
  res.json({ success: true, data: items.map((s) => s.job.toString()) });
});

export const saveJob = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id || '');
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid job id');

  const job = await Job.findById(id).select('_id').lean();
  if (!job) throw ApiError.notFound('Job not found');

  try {
    await SavedJob.create({
      user: req.user._id,
      job: new mongoose.Types.ObjectId(id),
    });
  } catch (err: unknown) {
    // Compound unique index — already saved is a no-op success.
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: number }).code === 11000
    ) {
      res.json({ success: true, message: 'Already saved' });
      return;
    }
    throw err;
  }

  res.status(201).json({ success: true, message: 'Job saved' });
});

export const unsaveJob = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id || '');
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid job id');

  await SavedJob.deleteOne({
    user: req.user._id,
    job: new mongoose.Types.ObjectId(id),
  });
  res.json({ success: true, message: 'Removed' });
});
