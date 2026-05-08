import { Response } from 'express';
import { z } from 'zod';
import { MockInterview, MockInterviewType } from '../models/MockInterview';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import {
  nextInterviewerTurn,
  summariseInterview,
} from '../services/ai/mockInterview.service';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

export const startMockSchema = z.object({
  body: z.object({
    role: z.string().min(2).max(100),
    interviewType: z
      .enum(['hr', 'technical', 'behavioural', 'system_design'])
      .default('behavioural'),
    questionsTarget: z.number().int().min(3).max(15).optional(),
  }),
});

export const answerMockSchema = z.object({
  body: z.object({
    answer: z.string().min(1).max(8000),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────

export const startMockInterview = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { role, interviewType, questionsTarget } = req.body as z.infer<
    typeof startMockSchema
  >['body'];

  const session = await MockInterview.create({
    user: req.user._id,
    role,
    interviewType,
    questionsTarget: questionsTarget ?? 6,
    turns: [],
    questionsAsked: 0,
  });

  // First interviewer turn — no candidate answer to score yet.
  const next = await nextInterviewerTurn({
    role,
    interviewType: interviewType as MockInterviewType,
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

export const answerMockInterview = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id)) throw ApiError.badRequest('Invalid id');

    const session = await MockInterview.findOne({
      _id: id,
      user: req.user._id,
    });
    if (!session) throw ApiError.notFound('Session not found');
    if (session.isCompleted) {
      throw ApiError.badRequest('This session is already complete');
    }

    const { answer } = req.body as z.infer<typeof answerMockSchema>['body'];
    session.turns.push({ role: 'candidate', text: answer, at: new Date() });

    const next = await nextInterviewerTurn({
      role: session.role,
      interviewType: session.interviewType,
      turns: session.turns,
      questionsTarget: session.questionsTarget,
    });

    // Attach feedback to the candidate's last turn (the answer we just got).
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
      // Final wrap question (asked, awaiting candidate's last word).
      session.turns.push({
        role: 'interviewer',
        text: next.question,
        at: new Date(),
      });
      session.questionsAsked = (session.questionsAsked ?? 0) + 1;
    } else {
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
  },
);

export const finishMockInterview = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id)) throw ApiError.badRequest('Invalid id');

    const session = await MockInterview.findOne({
      _id: id,
      user: req.user._id,
    });
    if (!session) throw ApiError.notFound('Session not found');
    if (session.isCompleted) {
      res.json({ success: true, data: session });
      return;
    }

    const { finalScore, finalSummary } = await summariseInterview({
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
  },
);

export const listMockInterviews = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const items = await MockInterview.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .select('role interviewType questionsAsked questionsTarget isCompleted finalScore createdAt completedAt')
    .lean();
  res.json({ success: true, data: items });
});

export const getMockInterview = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid id');
  const session = await MockInterview.findOne({
    _id: id,
    user: req.user._id,
  }).lean();
  if (!session) throw ApiError.notFound('Session not found');
  res.json({ success: true, data: session });
});
