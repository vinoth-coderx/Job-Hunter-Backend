"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAssessment = exports.listMyAssessments = exports.submitAssessment = exports.startAssessment = exports.submitAssessmentSchema = exports.startAssessmentSchema = void 0;
const zod_1 = require("zod");
const SkillAssessment_1 = require("../models/SkillAssessment");
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const skillAssessment_service_1 = require("../services/ai/skillAssessment.service");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
exports.startAssessmentSchema = zod_1.z.object({
    body: zod_1.z.object({
        skill: zod_1.z.string().min(2).max(100),
        level: zod_1.z
            .enum(['beginner', 'intermediate', 'advanced'])
            .default('intermediate'),
        count: zod_1.z.number().int().min(5).max(20).optional(),
    }),
});
exports.submitAssessmentSchema = zod_1.z.object({
    body: zod_1.z.object({
        answers: zod_1.z.array(zod_1.z.object({
            questionIndex: zod_1.z.number().int().min(0),
            selectedIndex: zod_1.z.number().int().min(0),
        })).min(1).max(20),
        timeTakenSeconds: zod_1.z.number().int().min(0).max(60 * 60 * 4).optional(),
    }),
});
exports.startAssessment = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { skill, level, count } = req.body;
    const questions = await (0, skillAssessment_service_1.generateAssessment)({
        skill,
        level: level,
        count,
    });
    const assessment = await SkillAssessment_1.SkillAssessment.create({
        user: req.user._id,
        skill: skill.toLowerCase().trim(),
        level,
        questions,
        passingScore: 70,
        startedAt: new Date(),
    });
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
exports.submitAssessment = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid assessment id');
    const a = await SkillAssessment_1.SkillAssessment.findOne({ _id: id, user: req.user._id });
    if (!a)
        throw ApiError_1.ApiError.notFound('Assessment not found');
    if (a.completedAt)
        throw ApiError_1.ApiError.conflict('Assessment already submitted');
    const body = req.body;
    const graded = [];
    let correct = 0;
    for (const ans of body.answers) {
        const q = a.questions[ans.questionIndex];
        if (!q)
            continue;
        const ok = ans.selectedIndex === q.correctIndex;
        if (ok)
            correct += 1;
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
    if (isPassed && !a.badgeAwarded) {
        a.badgeAwarded = true;
        try {
            await User_1.User.updateOne({ _id: req.user._id, 'profile.skills': { $ne: a.skill } }, { $push: { 'profile.skills': a.skill } });
        }
        catch {
        }
    }
    await a.save();
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
exports.listMyAssessments = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const items = await SkillAssessment_1.SkillAssessment.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .select('skill level scorePercent correctAnswers isPassed badgeAwarded passingScore startedAt completedAt createdAt')
        .lean();
    res.json({ success: true, data: items });
});
exports.getAssessment = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid id');
    const a = await SkillAssessment_1.SkillAssessment.findOne({ _id: id, user: req.user._id }).lean();
    if (!a)
        throw ApiError_1.ApiError.notFound('Assessment not found');
    const safeQuestions = a.questions.map((q, i) => {
        if (a.completedAt)
            return q;
        return {
            question: q.question,
            options: q.options,
            explanation: undefined,
            correctIndex: -1,
        };
    });
    res.json({ success: true, data: { ...a, questions: safeQuestions } });
});
