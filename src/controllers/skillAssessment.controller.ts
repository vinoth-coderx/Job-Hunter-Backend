import { Response } from 'express';
import { z } from 'zod';
import { SkillAssessment, ISkillAssessmentAnswer, AssessmentLevel } from '../models/SkillAssessment';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { generateAssessment } from '../services/ai/skillAssessment.service';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

export const startAssessmentSchema = z.object({
  body: z.object({
    skill: z.string().min(2).max(100),
    level: z
      .enum(['beginner', 'intermediate', 'advanced'])
      .default('intermediate'),
    count: z.number().int().min(5).max(20).optional(),
  }),
});

export const submitAssessmentSchema = z.object({
  body: z.object({
    answers: z.array(
      z.object({
        questionIndex: z.number().int().min(0),
        selectedIndex: z.number().int().min(0),
      }),
    ).min(1).max(20),
    timeTakenSeconds: z.number().int().min(0).max(60 * 60 * 4).optional(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────

export const startAssessment = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { skill, level, count } = req.body as z.infer<
    typeof startAssessmentSchema
  >['body'];

  const questions = await generateAssessment({
    skill,
    level: level as AssessmentLevel,
    count,
  });

  const assessment = await SkillAssessment.create({
    user: req.user._id,
    skill: skill.toLowerCase().trim(),
    level,
    questions,
    passingScore: 70,
    startedAt: new Date(),
  });

  // Strip correctIndex from the response — never reveal answers before submit.
  res.status(201).json({
    success: true,
    data: {
      id: assessment._id.toString(),
      skill: assessment.skill,
      level: assessment.level,
      passingScore: assessment.passingScore,
      questions: assessment.questions.map((q) => ({
        question: q.question,
        options: q.options,
      })),
    },
  });
});

export const submitAssessment = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid assessment id');

  const a = await SkillAssessment.findOne({ _id: id, user: req.user._id });
  if (!a) throw ApiError.notFound('Assessment not found');
  if (a.completedAt) throw ApiError.conflict('Assessment already submitted');

  const body = req.body as z.infer<typeof submitAssessmentSchema>['body'];

  // Score against the canonical correctIndex stored at start time.
  const graded: ISkillAssessmentAnswer[] = [];
  let correct = 0;
  for (const ans of body.answers) {
    const q = a.questions[ans.questionIndex];
    if (!q) continue; // out-of-range index — skip silently
    const ok = ans.selectedIndex === q.correctIndex;
    if (ok) correct += 1;
    graded.push({
      questionIndex: ans.questionIndex,
      selectedIndex: ans.selectedIndex,
      isCorrect: ok,
    });
  }
  const total = a.questions.length;
  const scorePercent = Math.round((correct / total) * 100);
  const isPassed = scorePercent >= a.passingScore;

  a.answers = graded;
  a.questionsAttempted = graded.length;
  a.correctAnswers = correct;
  a.scorePercent = scorePercent;
  a.timeTakenSeconds = body.timeTakenSeconds ?? 0;
  a.isPassed = isPassed;
  a.completedAt = new Date();

  // Award the badge + auto-mark the skill as verified on the user profile.
  if (isPassed && !a.badgeAwarded) {
    a.badgeAwarded = true;
    try {
      await User.updateOne(
        { _id: req.user._id, 'profile.skills': { $ne: a.skill } },
        { $push: { 'profile.skills': a.skill } },
      );
    } catch {
      // best-effort
    }
  }
  await a.save();

  // Echo correct answers + explanations back so the UI can show a review.
  res.json({
    success: true,
    data: {
      id: a._id.toString(),
      skill: a.skill,
      scorePercent,
      correctAnswers: correct,
      total,
      isPassed,
      badgeAwarded: a.badgeAwarded,
      review: a.questions.map((q, i) => ({
        question: q.question,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation,
        selectedIndex: graded.find((g) => g.questionIndex === i)?.selectedIndex,
        isCorrect: graded.find((g) => g.questionIndex === i)?.isCorrect ?? false,
      })),
    },
  });
});

export const listMyAssessments = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const items = await SkillAssessment.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .select(
      'skill level scorePercent correctAnswers isPassed badgeAwarded passingScore startedAt completedAt createdAt',
    )
    .lean();
  res.json({ success: true, data: items });
});

export const getAssessment = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid id');

  const a = await SkillAssessment.findOne({ _id: id, user: req.user._id }).lean();
  if (!a) throw ApiError.notFound('Assessment not found');

  // Hide correctIndex if not yet submitted.
  const safeQuestions = a.questions.map((q, i) => {
    if (a.completedAt) return q;
    return {
      question: q.question,
      options: q.options,
      explanation: undefined,
      correctIndex: -1,
    } as typeof q;
  });
  res.json({ success: true, data: { ...a, questions: safeQuestions } });
});
