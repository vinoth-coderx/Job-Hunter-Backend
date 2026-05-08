"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMockInterview = exports.listMockInterviews = exports.finishMockInterview = exports.answerMockInterview = exports.startMockInterview = exports.answerMockSchema = exports.startMockSchema = void 0;
const zod_1 = require("zod");
const MockInterview_1 = require("../models/MockInterview");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const mockInterview_service_1 = require("../services/ai/mockInterview.service");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
exports.startMockSchema = zod_1.z.object({
    body: zod_1.z.object({
        role: zod_1.z.string().min(2).max(100),
        interviewType: zod_1.z
            .enum(['hr', 'technical', 'behavioural', 'system_design'])
            .default('behavioural'),
        questionsTarget: zod_1.z.number().int().min(3).max(15).optional(),
    }),
});
exports.answerMockSchema = zod_1.z.object({
    body: zod_1.z.object({
        answer: zod_1.z.string().min(1).max(8000),
    }),
});
exports.startMockInterview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { role, interviewType, questionsTarget } = req.body;
    const session = await MockInterview_1.MockInterview.create({
        user: req.user._id,
        role,
        interviewType,
        questionsTarget: questionsTarget ?? 6,
        turns: [],
        questionsAsked: 0,
    });
    const next = await (0, mockInterview_service_1.nextInterviewerTurn)({
        role,
        interviewType: interviewType,
        turns: [],
        questionsTarget: session.questionsTarget,
    });
    session.turns.push({
        role: 'interviewer',
        text: next.question,
        at: new Date(),
    });
    session.questionsAsked = 1;
    await session.save();
    res.status(201).json({
        success: true,
        data: {
            id: session._id.toString(),
            role: session.role,
            interviewType: session.interviewType,
            questionsAsked: session.questionsAsked,
            questionsTarget: session.questionsTarget,
            latestQuestion: next.question,
        },
    });
});
exports.answerMockInterview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid id');
    const session = await MockInterview_1.MockInterview.findOne({
        _id: id,
        user: req.user._id,
    });
    if (!session)
        throw ApiError_1.ApiError.notFound('Session not found');
    if (session.isCompleted) {
        throw ApiError_1.ApiError.badRequest('This session is already complete');
    }
    const { answer } = req.body;
    session.turns.push({ role: 'candidate', text: answer, at: new Date() });
    const next = await (0, mockInterview_service_1.nextInterviewerTurn)({
        role: session.role,
        interviewType: session.interviewType,
        turns: session.turns,
        questionsTarget: session.questionsTarget,
    });
    if (next.feedback) {
        const lastCandidateIndex = session.turns
            .map((t, i) => ({ t, i }))
            .reverse()
            .find((x) => x.t.role === 'candidate')?.i;
        if (lastCandidateIndex !== undefined) {
            session.turns[lastCandidateIndex].feedback = next.feedback;
        }
    }
    if (next.shouldFinish) {
        session.turns.push({
            role: 'interviewer',
            text: next.question,
            at: new Date(),
        });
        session.questionsAsked = (session.questionsAsked ?? 0) + 1;
    }
    else {
        session.turns.push({
            role: 'interviewer',
            text: next.question,
            at: new Date(),
        });
        session.questionsAsked = (session.questionsAsked ?? 0) + 1;
    }
    await session.save();
    res.json({
        success: true,
        data: {
            id: session._id.toString(),
            questionsAsked: session.questionsAsked,
            questionsTarget: session.questionsTarget,
            latestFeedback: next.feedback,
            latestQuestion: next.question,
            shouldFinish: next.shouldFinish,
        },
    });
});
exports.finishMockInterview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid id');
    const session = await MockInterview_1.MockInterview.findOne({
        _id: id,
        user: req.user._id,
    });
    if (!session)
        throw ApiError_1.ApiError.notFound('Session not found');
    if (session.isCompleted) {
        res.json({ success: true, data: session });
        return;
    }
    const { finalScore, finalSummary } = await (0, mockInterview_service_1.summariseInterview)({
        role: session.role,
        interviewType: session.interviewType,
        turns: session.turns,
    });
    session.finalScore = finalScore;
    session.finalSummary = finalSummary;
    session.isCompleted = true;
    session.completedAt = new Date();
    await session.save();
    res.json({ success: true, data: session });
});
exports.listMockInterviews = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const items = await MockInterview_1.MockInterview.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .select('role interviewType questionsAsked questionsTarget isCompleted finalScore createdAt completedAt')
        .lean();
    res.json({ success: true, data: items });
});
exports.getMockInterview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid id');
    const session = await MockInterview_1.MockInterview.findOne({
        _id: id,
        user: req.user._id,
    }).lean();
    if (!session)
        throw ApiError_1.ApiError.notFound('Session not found');
    res.json({ success: true, data: session });
});
