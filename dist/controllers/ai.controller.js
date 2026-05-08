"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.skillGapEndpoint = exports.skillGapSchema = exports.profileOptimizerEndpoint = exports.generateCoverLetterEndpoint = exports.coverLetterSchema = void 0;
const zod_1 = require("zod");
const Job_1 = require("../models/Job");
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const coverLetter_service_1 = require("../services/ai/coverLetter.service");
const profileOptimizer_service_1 = require("../services/ai/profileOptimizer.service");
const skillGap_service_1 = require("../services/ai/skillGap.service");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
const ELIGIBLE_TIERS = ['monthly', 'yearly'];
exports.coverLetterSchema = zod_1.z.object({
    body: zod_1.z.object({
        jobId: zod_1.z.string().min(1),
        tone: zod_1.z
            .enum(['professional', 'friendly', 'technical'])
            .default('professional'),
        baseTemplate: zod_1.z.string().max(4000).optional(),
    }),
});
exports.generateCoverLetterEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    if (!ELIGIBLE_TIERS.includes(user.subscription.tier)) {
        throw ApiError_1.ApiError.forbidden('AI cover letters require a Pro or Elite plan. Upgrade to use this.');
    }
    const { jobId, tone, baseTemplate } = req.body;
    if (!isObjectId(jobId))
        throw ApiError_1.ApiError.badRequest('Invalid jobId');
    const job = await Job_1.Job.findById(jobId);
    if (!job)
        throw ApiError_1.ApiError.notFound('Job not found');
    const result = await (0, coverLetter_service_1.generateCoverLetter)({
        user,
        job,
        tone,
        baseTemplate,
    });
    res.json({ success: true, data: result });
});
exports.profileOptimizerEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const result = await (0, profileOptimizer_service_1.optimizeProfile)(user);
    res.json({ success: true, data: result });
});
exports.skillGapSchema = zod_1.z.object({
    body: zod_1.z.object({
        role: zod_1.z.string().min(2).max(100),
        city: zod_1.z.string().max(100).optional(),
    }),
});
exports.skillGapEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const { role, city } = req.body;
    const result = await (0, skillGap_service_1.analyseSkillGap)(user, role, city);
    res.json({ success: true, data: result });
});
