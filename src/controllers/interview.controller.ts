import { Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Interview } from '../models/Interview';
import { AppliedJob } from '../models/AppliedJob';
import { HirerProfile } from '../models/HirerProfile';
import { Notification } from '../models/Notification';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

const interviewerInput = z.object({
  user: z.string().min(1).optional(),
  name: z.string().min(1).max(100),
  designation: z.string().max(100).optional(),
});

export const scheduleInterviewSchema = z.object({
  body: z.object({
    applicationId: z.string().min(1),
    round: z.enum(['hr', 'technical', 'managerial', 'final', 'assessment']),
    interviewType: z.enum(['video', 'phone', 'in_person']),
    scheduledAt: z.coerce.date(),
    durationMinutes: z.number().int().min(5).max(480).default(45),
    meetingLink: z.string().url().max(1000).optional(),
    meetingPlatform: z.string().max(50).optional(),
    location: z.string().max(500).optional(),
    interviewers: z.array(interviewerInput).max(8).optional(),
    notesToCandidate: z.string().max(2000).optional(),
    notesToInterviewer: z.string().max(2000).optional(),
    timezone: z.string().max(50).optional(),
  }),
});

export const updateInterviewSchema = z.object({
  body: z.object({
    scheduledAt: z.coerce.date().optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    meetingLink: z.string().url().max(1000).optional(),
    meetingPlatform: z.string().max(50).optional(),
    location: z.string().max(500).optional(),
    notesToCandidate: z.string().max(2000).optional(),
    notesToInterviewer: z.string().max(2000).optional(),
    status: z.enum(['scheduled', 'completed', 'cancelled', 'rescheduled', 'no_show']).optional(),
  }),
});

export const submitFeedbackSchema = z.object({
  body: z.object({
    rating: z.number().int().min(1).max(5).optional(),
    technicalScore: z.number().int().min(0).max(100).optional(),
    communicationScore: z.number().int().min(0).max(100).optional(),
    culturalFitScore: z.number().int().min(0).max(100).optional(),
    recommendation: z.enum(['strong_yes', 'yes', 'maybe', 'no', 'strong_no']).optional(),
    notes: z.string().max(4000).optional(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const requireHirerProfile = async (userId: string) => {
  const profile = await HirerProfile.findOne({ user: userId }).select('_id user').lean();
  if (!profile) throw ApiError.forbidden('Set up a company profile first');
  return profile;
};

// ─────────────────────────────────────────────────────────────────────────
// Hirer endpoints
// ─────────────────────────────────────────────────────────────────────────

export const scheduleInterview = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);

  const body = req.body as z.infer<typeof scheduleInterviewSchema>['body'];
  if (!isObjectId(body.applicationId)) throw ApiError.badRequest('Invalid applicationId');
  if (body.scheduledAt < new Date()) {
    throw ApiError.badRequest('Cannot schedule interview in the past');
  }

  const application = await AppliedJob.findById(body.applicationId).populate({
    path: 'job',
    select: 'hirerProfile title isNative',
  });
  if (!application) throw ApiError.notFound('Application not found');

  const job = application.job as unknown as
    | { hirerProfile?: mongoose.Types.ObjectId; title: string; isNative?: boolean }
    | null;
  if (
    !job ||
    !job.hirerProfile ||
    job.hirerProfile.toString() !== profile._id.toString()
  ) {
    throw ApiError.forbidden('Not your job');
  }

  const interview = await Interview.create({
    application: application._id,
    job: application.job,
    seekerUser: application.user,
    hirerUser: req.user._id,
    hirerProfile: profile._id,
    round: body.round,
    interviewType: body.interviewType,
    scheduledAt: body.scheduledAt,
    durationMinutes: body.durationMinutes,
    meetingLink: body.meetingLink,
    meetingPlatform: body.meetingPlatform,
    location: body.location,
    interviewers: body.interviewers,
    notesToCandidate: body.notesToCandidate,
    notesToInterviewer: body.notesToInterviewer,
    timezone: body.timezone ?? 'Asia/Kolkata',
    inviteSentAt: new Date(),
  });

  // Move the application status forward.
  if (application.status !== 'interview') {
    application.status = 'interview';
    application.statusHistory.push({
      status: 'interview',
      changedAt: new Date(),
      changedBy: new mongoose.Types.ObjectId(req.user._id!.toString()),
      note: `Interview scheduled (${body.round})`,
    });
    await application.save();
  }

  // Notify the candidate.
  try {
    await Notification.create({
      user: application.user,
      role: 'seeker',
      type: 'interview_scheduled',
      title: `Interview scheduled — ${job.title}`,
      body: `${body.round.toUpperCase()} interview on ${interview.scheduledAt.toISOString()}`,
      data: {
        interviewId: interview._id.toString(),
        applicationId: application._id.toString(),
      },
    });
  } catch {
    // best-effort
  }

  res.status(201).json({ success: true, data: interview });
});

export const listHirerInterviews = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const profile = await requireHirerProfile(req.user.id);

  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const filter: Record<string, unknown> = { hirerProfile: profile._id };
  if (status) filter.status = status;

  const items = await Interview.find(filter)
    .sort({ scheduledAt: 1 })
    .populate({ path: 'seekerUser', select: 'email profile.fullName profile.avatar' })
    .populate({ path: 'job', select: 'title' })
    .lean();

  res.json({ success: true, data: items });
});

export const getInterview = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid id');

  const interview = await Interview.findById(id)
    .populate({ path: 'seekerUser', select: 'email profile.fullName profile.avatar' })
    .populate({ path: 'hirerUser', select: 'email profile.fullName' })
    .populate({ path: 'job', select: 'title company' });
  if (!interview) throw ApiError.notFound('Interview not found');

  // Either participant may view.
  const me = req.user._id!.toString();
  if (
    interview.seekerUser.toString() !== me &&
    interview.hirerUser.toString() !== me
  ) {
    throw ApiError.forbidden('Not a participant of this interview');
  }
  res.json({ success: true, data: interview });
});

export const updateInterview = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid id');
  const profile = await requireHirerProfile(req.user.id);

  const interview = await Interview.findById(id);
  if (!interview) throw ApiError.notFound('Interview not found');
  if (interview.hirerProfile.toString() !== profile._id.toString()) {
    throw ApiError.forbidden('Not your interview');
  }

  const body = req.body as z.infer<typeof updateInterviewSchema>['body'];
  // Reschedule note for the timeline.
  const wasReschedule = body.scheduledAt &&
    interview.scheduledAt.getTime() !== new Date(body.scheduledAt).getTime();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (interview as any)[k] = v;
  }
  if (wasReschedule && !body.status) {
    interview.status = 'rescheduled';
  }
  await interview.save();

  // Notify candidate of any change.
  try {
    await Notification.create({
      user: interview.seekerUser,
      role: 'seeker',
      type: 'interview_scheduled',
      title: 'Interview updated',
      body: `Status: ${interview.status} · ${interview.scheduledAt.toISOString()}`,
      data: { interviewId: interview._id.toString() },
    });
  } catch {
    // ignore
  }

  res.json({ success: true, data: interview });
});

export const cancelInterview = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid id');
  const profile = await requireHirerProfile(req.user.id);

  const interview = await Interview.findById(id);
  if (!interview) throw ApiError.notFound('Interview not found');
  if (interview.hirerProfile.toString() !== profile._id.toString()) {
    throw ApiError.forbidden('Not your interview');
  }

  interview.status = 'cancelled';
  await interview.save();

  res.json({ success: true, data: { id: interview._id.toString() } });
});

export const submitFeedback = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid id');
  const profile = await requireHirerProfile(req.user.id);

  const interview = await Interview.findById(id);
  if (!interview) throw ApiError.notFound('Interview not found');
  if (interview.hirerProfile.toString() !== profile._id.toString()) {
    throw ApiError.forbidden('Not your interview');
  }

  const body = req.body as z.infer<typeof submitFeedbackSchema>['body'];
  interview.feedback = {
    ...(interview.feedback ?? {}),
    ...body,
    submittedAt: new Date(),
    submittedBy: new mongoose.Types.ObjectId(req.user._id!.toString()),
  };
  if (interview.status === 'scheduled') interview.status = 'completed';
  await interview.save();

  res.json({ success: true, data: interview });
});

// ─────────────────────────────────────────────────────────────────────────
// Seeker endpoints
// ─────────────────────────────────────────────────────────────────────────

export const listSeekerInterviews = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const items = await Interview.find({ seekerUser: req.user._id })
    .sort({ scheduledAt: 1 })
    .populate({ path: 'job', select: 'title company' })
    .populate({ path: 'hirerProfile', select: 'companyName companyLogoUrl' })
    .lean();
  res.json({ success: true, data: items });
});

export const confirmInterview = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid id');

  const interview = await Interview.findOne({
    _id: id,
    seekerUser: req.user._id,
  });
  if (!interview) throw ApiError.notFound('Interview not found');

  interview.candidateConfirmed = true;
  await interview.save();

  res.json({ success: true, data: { id: interview._id.toString(), candidateConfirmed: true } });
});
