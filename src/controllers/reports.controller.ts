import { Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { Report } from '../models/Report';
import { writeAudit } from '../services/security/audit.service';

export const createReportSchema = z.object({
  body: z.object({
    subjectType: z.enum(['job', 'recruiter', 'message', 'company', 'review']),
    subjectId: z.string().regex(/^[0-9a-fA-F]{24}$/),
    reason: z.enum([
      'fake_job',
      'fake_recruiter',
      'asks_payment',
      'mlm_scam',
      'misleading_salary',
      'discriminatory',
      'duplicate',
      'harassment',
      'spam',
      'phishing_link',
      'whatsapp_only_contact',
      'other',
    ]),
    description: z.string().max(2000).optional(),
    evidenceUrls: z.array(z.string().url()).max(5).optional(),
  }),
});

export const createReport = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const dup = await Report.findOne({
    reporter: req.user._id,
    subjectType: req.body.subjectType,
    subjectId: req.body.subjectId,
    status: { $in: ['open', 'under_review'] },
  });
  if (dup) {
    res.json({ success: true, data: dup, deduped: true });
    return;
  }
  const report = await Report.create({
    reporter: req.user._id,
    subjectType: req.body.subjectType,
    subjectId: new mongoose.Types.ObjectId(req.body.subjectId),
    reason: req.body.reason,
    description: req.body.description,
    evidenceUrls: req.body.evidenceUrls ?? [],
  });
  await writeAudit({
    actor: { id: req.user._id, email: req.user.email },
    actorType: 'user',
    category: 'security',
    action: `report:${req.body.subjectType}:${req.body.reason}`,
    target: { type: req.body.subjectType, id: req.body.subjectId },
    req,
  });
  res.status(201).json({ success: true, data: report });
});

export const listMyReports = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const reports = await Report.find({ reporter: req.user._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  res.json({ success: true, data: reports });
});
