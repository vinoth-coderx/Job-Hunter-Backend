"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.confirmInterview = exports.listSeekerInterviews = exports.submitFeedback = exports.cancelInterview = exports.updateInterview = exports.getInterview = exports.listHirerInterviews = exports.scheduleInterview = exports.submitFeedbackSchema = exports.updateInterviewSchema = exports.scheduleInterviewSchema = void 0;
const zod_1 = require("zod");
const mongoose_1 = __importDefault(require("mongoose"));
const Interview_1 = require("../models/Interview");
const AppliedJob_1 = require("../models/AppliedJob");
const HirerProfile_1 = require("../models/HirerProfile");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const notify_service_1 = require("../services/notification/notify.service");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
const interviewerInput = zod_1.z.object({
    user: zod_1.z.string().min(1).optional(),
    name: zod_1.z.string().min(1).max(100),
    designation: zod_1.z.string().max(100).optional(),
});
exports.scheduleInterviewSchema = zod_1.z.object({
    body: zod_1.z.object({
        applicationId: zod_1.z.string().min(1),
        round: zod_1.z.enum(['hr', 'technical', 'managerial', 'final', 'assessment']),
        interviewType: zod_1.z.enum(['video', 'phone', 'in_person']),
        scheduledAt: zod_1.z.coerce.date(),
        durationMinutes: zod_1.z.number().int().min(5).max(480).default(45),
        meetingLink: zod_1.z.string().url().max(1000).optional(),
        meetingPlatform: zod_1.z.string().max(50).optional(),
        location: zod_1.z.string().max(500).optional(),
        interviewers: zod_1.z.array(interviewerInput).max(8).optional(),
        notesToCandidate: zod_1.z.string().max(2000).optional(),
        notesToInterviewer: zod_1.z.string().max(2000).optional(),
        timezone: zod_1.z.string().max(50).optional(),
    }),
});
exports.updateInterviewSchema = zod_1.z.object({
    body: zod_1.z.object({
        scheduledAt: zod_1.z.coerce.date().optional(),
        durationMinutes: zod_1.z.number().int().min(5).max(480).optional(),
        meetingLink: zod_1.z.string().url().max(1000).optional(),
        meetingPlatform: zod_1.z.string().max(50).optional(),
        location: zod_1.z.string().max(500).optional(),
        notesToCandidate: zod_1.z.string().max(2000).optional(),
        notesToInterviewer: zod_1.z.string().max(2000).optional(),
        status: zod_1.z.enum(['scheduled', 'completed', 'cancelled', 'rescheduled', 'no_show']).optional(),
    }),
});
exports.submitFeedbackSchema = zod_1.z.object({
    body: zod_1.z.object({
        rating: zod_1.z.number().int().min(1).max(5).optional(),
        technicalScore: zod_1.z.number().int().min(0).max(100).optional(),
        communicationScore: zod_1.z.number().int().min(0).max(100).optional(),
        culturalFitScore: zod_1.z.number().int().min(0).max(100).optional(),
        recommendation: zod_1.z.enum(['strong_yes', 'yes', 'maybe', 'no', 'strong_no']).optional(),
        notes: zod_1.z.string().max(4000).optional(),
    }),
});
const requireHirerProfile = async (userId) => {
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: userId }).select('_id user').lean();
    if (!profile)
        throw ApiError_1.ApiError.forbidden('Set up a company profile first');
    return profile;
};
exports.scheduleInterview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const body = req.body;
    if (!isObjectId(body.applicationId))
        throw ApiError_1.ApiError.badRequest('Invalid applicationId');
    if (body.scheduledAt < new Date()) {
        throw ApiError_1.ApiError.badRequest('Cannot schedule interview in the past');
    }
    const application = await AppliedJob_1.AppliedJob.findById(body.applicationId).populate({
        path: 'job',
        select: 'hirerProfile title isNative',
    });
    if (!application)
        throw ApiError_1.ApiError.notFound('Application not found');
    const job = application.job;
    if (!job ||
        !job.hirerProfile ||
        job.hirerProfile.toString() !== profile._id.toString()) {
        throw ApiError_1.ApiError.forbidden('Not your job');
    }
    const interview = await Interview_1.Interview.create({
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
    if (application.status !== 'interview') {
        application.status = 'interview';
        application.statusHistory.push({
            status: 'interview',
            changedAt: new Date(),
            changedBy: new mongoose_1.default.Types.ObjectId(req.user._id.toString()),
            note: `Interview scheduled (${body.round})`,
        });
        await application.save();
    }
    try {
        await (0, notify_service_1.notifyUser)({
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
    }
    catch {
    }
    res.status(201).json({ success: true, data: interview });
});
exports.listHirerInterviews = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireHirerProfile(req.user.id);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const filter = { hirerProfile: profile._id };
    if (status)
        filter.status = status;
    const items = await Interview_1.Interview.find(filter)
        .sort({ scheduledAt: 1 })
        .populate({ path: 'seekerUser', select: 'email profile.fullName profile.avatar' })
        .populate({ path: 'job', select: 'title' })
        .lean();
    res.json({ success: true, data: items });
});
exports.getInterview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid id');
    const interview = await Interview_1.Interview.findById(id)
        .populate({ path: 'seekerUser', select: 'email profile.fullName profile.avatar' })
        .populate({ path: 'hirerUser', select: 'email profile.fullName' })
        .populate({ path: 'job', select: 'title company' });
    if (!interview)
        throw ApiError_1.ApiError.notFound('Interview not found');
    const me = req.user._id.toString();
    if (interview.seekerUser.toString() !== me &&
        interview.hirerUser.toString() !== me) {
        throw ApiError_1.ApiError.forbidden('Not a participant of this interview');
    }
    res.json({ success: true, data: interview });
});
exports.updateInterview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid id');
    const profile = await requireHirerProfile(req.user.id);
    const interview = await Interview_1.Interview.findById(id);
    if (!interview)
        throw ApiError_1.ApiError.notFound('Interview not found');
    if (interview.hirerProfile.toString() !== profile._id.toString()) {
        throw ApiError_1.ApiError.forbidden('Not your interview');
    }
    const body = req.body;
    const wasReschedule = body.scheduledAt &&
        interview.scheduledAt.getTime() !== new Date(body.scheduledAt).getTime();
    for (const [k, v] of Object.entries(body)) {
        if (v === undefined)
            continue;
        interview[k] = v;
    }
    if (wasReschedule && !body.status) {
        interview.status = 'rescheduled';
    }
    await interview.save();
    try {
        await (0, notify_service_1.notifyUser)({
            user: interview.seekerUser,
            role: 'seeker',
            type: 'interview_scheduled',
            title: 'Interview updated',
            body: `Status: ${interview.status} · ${interview.scheduledAt.toISOString()}`,
            data: { interviewId: interview._id.toString() },
        });
    }
    catch {
    }
    res.json({ success: true, data: interview });
});
exports.cancelInterview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid id');
    const profile = await requireHirerProfile(req.user.id);
    const interview = await Interview_1.Interview.findById(id);
    if (!interview)
        throw ApiError_1.ApiError.notFound('Interview not found');
    if (interview.hirerProfile.toString() !== profile._id.toString()) {
        throw ApiError_1.ApiError.forbidden('Not your interview');
    }
    interview.status = 'cancelled';
    await interview.save();
    res.json({ success: true, data: { id: interview._id.toString() } });
});
exports.submitFeedback = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid id');
    const profile = await requireHirerProfile(req.user.id);
    const interview = await Interview_1.Interview.findById(id);
    if (!interview)
        throw ApiError_1.ApiError.notFound('Interview not found');
    if (interview.hirerProfile.toString() !== profile._id.toString()) {
        throw ApiError_1.ApiError.forbidden('Not your interview');
    }
    const body = req.body;
    interview.feedback = {
        ...(interview.feedback ?? {}),
        ...body,
        submittedAt: new Date(),
        submittedBy: new mongoose_1.default.Types.ObjectId(req.user._id.toString()),
    };
    if (interview.status === 'scheduled')
        interview.status = 'completed';
    await interview.save();
    res.json({ success: true, data: interview });
});
exports.listSeekerInterviews = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const items = await Interview_1.Interview.find({ seekerUser: req.user._id })
        .sort({ scheduledAt: 1 })
        .populate({ path: 'job', select: 'title company' })
        .populate({ path: 'hirerProfile', select: 'companyName companyLogoUrl' })
        .lean();
    res.json({ success: true, data: items });
});
exports.confirmInterview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid id');
    const interview = await Interview_1.Interview.findOne({
        _id: id,
        seekerUser: req.user._id,
    });
    if (!interview)
        throw ApiError_1.ApiError.notFound('Interview not found');
    interview.candidateConfirmed = true;
    await interview.save();
    res.json({ success: true, data: { id: interview._id.toString(), candidateConfirmed: true } });
});
