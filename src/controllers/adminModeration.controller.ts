import { Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { Job } from '../models/Job';
import { JobModeration } from '../models/JobModeration';
import { Report } from '../models/Report';
import { AuditLog } from '../models/AuditLog';
import { SecurityEvent } from '../models/SecurityEvent';
import { Verification } from '../models/Verification';
import { HirerProfile } from '../models/HirerProfile';
import { writeAudit } from '../services/security/audit.service';
import { recomputeHirerTrust } from '../services/security/trustScore.service';
import { notifyUser } from '../services/notification/notify.service';

// ─── Moderation queue ─────────────────────────────────────────────────────

export const listModerationQueue = asyncHandler(async (req: AuthRequest, res: Response) => {
  const status = (req.query.status as string) || 'queued';
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const skip = Number(req.query.skip) || 0;
  const filter: Record<string, unknown> = {};
  if (status !== 'all') filter['moderation.status'] = status;
  filter.isNative = true;
  const [items, total] = await Promise.all([
    Job.find(filter)
      .sort({ 'moderation.lastModelRun': -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('hirerProfile', 'companyName trustScore verification.isVerified')
      .populate('postedBy', 'email profile.fullName')
      .lean(),
    Job.countDocuments(filter),
  ]);
  res.json({ success: true, data: { items, total } });
});

export const moderationDecisionSchema = z.object({
  body: z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(2000).optional(),
  }),
});

export const decideModeration = asyncHandler(async (req: AuthRequest, res: Response) => {
  const job = await Job.findById(req.params.id);
  if (!job) throw new ApiError(404, 'Job not found');
  if (req.body.decision === 'approve') {
    job.moderation.status = 'approved';
    job.isPublic = true;
  } else {
    job.moderation.status = 'rejected';
    job.isPublic = false;
    job.status = 'closed';
  }
  job.moderation.reviewedAt = new Date();
  job.moderation.reviewedBy = req.user!._id;
  job.moderation.reviewNote = req.body.note;
  await job.save();

  await JobModeration.findOneAndUpdate(
    { job: job._id },
    {
      $set: {
        overrideDecision: req.body.decision === 'approve' ? 'approved' : 'rejected',
        overrideNote: req.body.note,
        reviewedBy: req.user!._id,
        reviewedAt: new Date(),
      },
    },
    { sort: { createdAt: -1 } },
  );

  await writeAudit({
    actor: { id: req.user!._id, email: req.user!.email },
    actorType: 'admin',
    category: 'job_moderation',
    action: `moderation:${req.body.decision}`,
    target: { type: 'Job', id: job._id, label: job.title },
    metadata: { note: req.body.note },
    req,
  });
  res.json({ success: true });
});

// ─── Moderation appeals (hirer-filed) ────────────────────────────────────

export const listModerationAppeals = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const status = (req.query.status as string) || 'pending';
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const skip = Number(req.query.skip) || 0;

    const filter: Record<string, unknown> = { 'appeal.status': status };
    const [items, total] = await Promise.all([
      JobModeration.find(filter)
        .sort({ 'appeal.submittedAt': 1 })
        .skip(skip)
        .limit(limit)
        .populate('job', 'title company status moderation.status')
        .populate('hirer', 'email profile.fullName')
        .lean(),
      JobModeration.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, total } });
  },
);

export const resolveAppealSchema = z.object({
  body: z.object({
    decision: z.enum(['accept', 'reject']),
    adminNote: z.string().max(2000).optional(),
  }),
});

/**
 * Admin resolves a hirer-filed appeal.
 *   - accept  → flip the moderation override to 'approved' and re-publish
 *               the job (status='active', isPublic=true).
 *   - reject  → leave the job as-is, mark the appeal closed.
 *
 * Either way, the appeal subdoc is annotated with status + adminNote so
 * the audit trail captures who decided what + why.
 */
export const resolveModerationAppeal = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = String(req.params.id);
    if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid id');

    const moderation = await JobModeration.findById(id);
    if (!moderation) throw new ApiError(404, 'Moderation row not found');
    if (!moderation.appeal || moderation.appeal.status !== 'pending') {
      throw new ApiError(400, 'No pending appeal on this row');
    }

    const { decision, adminNote } = req.body as z.infer<
      typeof resolveAppealSchema
    >['body'];
    const accepted = decision === 'accept';

    moderation.appeal.status = accepted ? 'accepted' : 'rejected';
    moderation.appeal.adminNote = adminNote;
    moderation.appeal.resolvedBy = req.user!._id;
    moderation.appeal.resolvedAt = new Date();
    if (accepted) {
      moderation.overrideDecision = 'approved';
      moderation.overrideNote = adminNote;
      moderation.reviewedBy = req.user!._id;
      moderation.reviewedAt = new Date();
    }
    await moderation.save();

    let republishedJobId: string | undefined;
    if (accepted) {
      const job = await Job.findById(moderation.job);
      if (job) {
        job.moderation.status = 'approved';
        job.moderation.reviewedAt = new Date();
        job.moderation.reviewedBy = req.user!._id;
        job.moderation.reviewNote = adminNote;
        job.isPublic = true;
        // Reopen if previously closed by the auto-rejection; if the
        // hirer already manually closed it, leave it closed.
        if (job.status === 'closed' && !job.closedAt) {
          job.status = 'active';
          job.isActive = true;
          job.publishedAt = job.publishedAt ?? new Date();
        }
        await job.save();
        republishedJobId = job._id.toString();
      }
    }

    await writeAudit({
      actor: { id: req.user!._id, email: req.user!.email },
      actorType: 'admin',
      category: 'job_moderation',
      action: `moderation:appeal_${decision}`,
      target: { type: 'Job', id: moderation.job, label: undefined },
      metadata: { adminNote, republishedJobId },
      req,
    });

    // Tell the hirer the appeal landed. Best-effort — failures here
    // never block the admin's resolve action. The 'system' type slots
    // into the existing notification inbox without a Flutter schema
    // change; data.subType disambiguates for any future tap-routing.
    const jobDoc = await Job.findById(moderation.job).select('title');
    const title = accepted
      ? 'Your job has been re-approved'
      : 'Your appeal was reviewed';
    const body = accepted
      ? `"${jobDoc?.title ?? 'Your listing'}" is back live after admin review.`
      : `"${jobDoc?.title ?? 'Your listing'}" stays rejected. ${
          adminNote
            ? `Admin note: ${adminNote.slice(0, 200)}`
            : 'No further note from the reviewer.'
        }`;
    try {
      await notifyUser({
        user: moderation.hirer,
        role: 'hirer',
        type: 'system',
        title,
        body,
        data: {
          subType: 'moderation_appeal',
          jobId: moderation.job.toString(),
          decision,
          adminNote: adminNote ?? null,
        },
      });
    } catch (err) {
      // Audit log already captured the resolution — swallow notify
      // failure so the admin's request still succeeds.
      // eslint-disable-next-line no-console
      console.warn(`appeal notify skipped: ${(err as Error).message}`);
    }

    res.json({
      success: true,
      data: {
        appealStatus: moderation.appeal.status,
        republishedJobId,
      },
    });
  },
);

// ─── Reports queue ────────────────────────────────────────────────────────

export const listReports = asyncHandler(async (req: AuthRequest, res: Response) => {
  const status = (req.query.status as string) || 'open';
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const filter: Record<string, unknown> = {};
  if (status !== 'all') filter.status = status;
  const reports = await Report.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('reporter', 'email profile.fullName')
    .lean();
  res.json({ success: true, data: reports });
});

export const resolveReportSchema = z.object({
  body: z.object({
    action: z.enum([
      'job_unpublished',
      'recruiter_warned',
      'recruiter_suspended',
      'recruiter_banned',
      'company_flagged',
      'no_action',
    ]),
    note: z.string().max(2000).optional(),
  }),
});

export const resolveReport = asyncHandler(async (req: AuthRequest, res: Response) => {
  const report = await Report.findById(req.params.id);
  if (!report) throw new ApiError(404, 'Report not found');
  const status = req.body.action === 'no_action' ? 'dismissed' : 'actioned';
  report.status = status;
  report.action = req.body.action;
  report.resolutionNote = req.body.note;
  report.resolvedAt = new Date();
  report.resolvedBy = req.user!._id;
  await report.save();

  // Side-effects
  if (req.body.action === 'job_unpublished' && report.subjectType === 'job') {
    await Job.findByIdAndUpdate(report.subjectId, {
      $set: { isPublic: false, status: 'closed', 'moderation.status': 'rejected' },
    });
  }
  if (
    (req.body.action === 'recruiter_suspended' || req.body.action === 'recruiter_banned') &&
    report.subjectType === 'recruiter'
  ) {
    await HirerProfile.findByIdAndUpdate(report.subjectId, {
      $set: { approvalStatus: req.body.action === 'recruiter_banned' ? 'banned' : 'suspended' },
    });
  }
  await writeAudit({
    actor: { id: req.user!._id, email: req.user!.email },
    actorType: 'admin',
    category: 'security',
    action: `report:${req.body.action}`,
    target: { type: report.subjectType, id: report.subjectId },
    req,
  });
  res.json({ success: true });
});

// ─── Audit logs ──────────────────────────────────────────────────────────

export const listAuditLogs = asyncHandler(async (req: AuthRequest, res: Response) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const skip = Number(req.query.skip) || 0;
  const filter: Record<string, unknown> = {};
  if (req.query.category) filter.category = req.query.category;
  if (req.query.actorType) filter.actorType = req.query.actorType;
  if (req.query.actor) filter.actor = new mongoose.Types.ObjectId(req.query.actor as string);
  // Optional action prefix filter — used by the chat-safety dashboard
  // to scope to `action: chat:blocked:*` without re-running heuristics
  // on the model. Anchored to the start of the field so a substring
  // hit doesn't pull in unrelated actions.
  if (typeof req.query.actionPrefix === 'string' && req.query.actionPrefix.length > 0) {
    const escaped = (req.query.actionPrefix as string).replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    filter.action = { $regex: `^${escaped}` };
  }
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ success: true, data: { items, total } });
});

// ─── Security events ─────────────────────────────────────────────────────

export const listSecurityEvents = asyncHandler(async (req: AuthRequest, res: Response) => {
  const filter: Record<string, unknown> = {};
  if (req.query.severity) filter.severity = req.query.severity;
  if (req.query.acknowledged !== undefined) filter.acknowledged = req.query.acknowledged === 'true';
  const items = await SecurityEvent.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .populate('user', 'email profile.fullName')
    .lean();
  res.json({ success: true, data: items });
});

export const acknowledgeSecurityEvent = asyncHandler(async (req: AuthRequest, res: Response) => {
  const ev = await SecurityEvent.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        acknowledged: true,
        acknowledgedBy: req.user!._id,
        acknowledgedAt: new Date(),
        resolved: req.body.resolve === true,
        resolvedAt: req.body.resolve === true ? new Date() : undefined,
        resolutionNote: req.body.note,
      },
    },
    { new: true },
  );
  if (!ev) throw new ApiError(404, 'Event not found');
  res.json({ success: true, data: ev });
});

/// Bulk acknowledge — clears every unacknowledged event at or below
/// the given severity floor in one shot. The admin uses this after a
/// triage pass to drop low-noise rows out of the queue.
export const bulkAckSecurityEvents = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const ALLOWED = ['info', 'low', 'medium', 'high', 'critical'] as const;
    const max = (req.body?.maxSeverity ?? 'low') as typeof ALLOWED[number];
    const order = ALLOWED.indexOf(max);
    if (order < 0) throw new ApiError(400, 'Invalid maxSeverity');
    const target = ALLOWED.slice(0, order + 1);
    const result = await SecurityEvent.updateMany(
      {
        acknowledged: false,
        severity: { $in: Array.from(target) },
      },
      {
        $set: {
          acknowledged: true,
          acknowledgedBy: req.user!._id,
          acknowledgedAt: new Date(),
        },
      },
    );
    await writeAudit({
      actor: { id: req.user!._id, email: req.user!.email },
      actorType: 'admin',
      category: 'security',
      action: `security:bulk_ack:${max}`,
      metadata: { modified: result.modifiedCount ?? 0 },
      req,
    });
    res.json({ success: true, modified: result.modifiedCount ?? 0 });
  },
);

// ─── Verification queue ──────────────────────────────────────────────────

export const listVerificationQueue = asyncHandler(async (req: AuthRequest, res: Response) => {
  const status = (req.query.status as string) || 'pending';
  const items = await Verification.find(status === 'all' ? {} : { status })
    .sort({ createdAt: -1 })
    .limit(200)
    .populate('hirer', 'email profile.fullName')
    .populate('company', 'companyName website verification')
    .lean();
  res.json({ success: true, data: items });
});

export const reviewVerificationSchema = z.object({
  body: z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(2000).optional(),
  }),
});

export const reviewVerification = asyncHandler(async (req: AuthRequest, res: Response) => {
  const v = await Verification.findById(req.params.id);
  if (!v) throw new ApiError(404, 'Verification submission not found');
  v.status = req.body.decision === 'approve' ? 'approved' : 'rejected';
  v.reviewNote = req.body.note;
  v.reviewedBy = req.user!._id;
  v.reviewedAt = new Date();
  await v.save();

  if (req.body.decision === 'approve') {
    const profile = await HirerProfile.findById(v.company);
    if (profile) {
      const k = v.channel === 'domain_email' ? 'domainEmail' : v.channel;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (profile.verification.levels as any)[k] = true;
      profile.verification.isVerified = Object.values(profile.verification.levels).some(Boolean);
      if (profile.verification.isVerified && !profile.verification.verifiedAt) {
        profile.verification.verifiedAt = new Date();
      }
      await profile.save();
      await recomputeHirerTrust(profile.user);
    }
  }
  await writeAudit({
    actor: { id: req.user!._id, email: req.user!.email },
    actorType: 'admin',
    category: 'verification',
    action: `verification:${v.channel}:${req.body.decision}`,
    target: { type: 'Verification', id: v._id },
    metadata: { note: req.body.note },
    req,
  });
  res.json({ success: true });
});

// ─── Hirer approval ──────────────────────────────────────────────────────

export const approveHirerSchema = z.object({
  body: z.object({
    decision: z.enum(['approve', 'suspend', 'ban']),
    note: z.string().max(2000).optional(),
  }),
});

export const reviewHirer = asyncHandler(async (req: AuthRequest, res: Response) => {
  const profile = await HirerProfile.findById(req.params.id);
  if (!profile) throw new ApiError(404, 'Hirer profile not found');
  const map = { approve: 'approved', suspend: 'suspended', ban: 'banned' } as const;
  profile.approvalStatus = map[req.body.decision as keyof typeof map];
  profile.approvalNote = req.body.note;
  if (req.body.decision === 'approve') {
    profile.approvedAt = new Date();
    profile.approvedBy = req.user!._id;
  }
  await profile.save();
  await recomputeHirerTrust(profile.user);
  await writeAudit({
    actor: { id: req.user!._id, email: req.user!.email },
    actorType: 'admin',
    category: 'hirer',
    action: `hirer:${req.body.decision}`,
    target: { type: 'HirerProfile', id: profile._id, label: profile.companyName },
    metadata: { note: req.body.note },
    req,
  });
  res.json({ success: true });
});
