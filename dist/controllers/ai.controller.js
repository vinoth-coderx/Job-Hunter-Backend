"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatStreamEndpoint = exports.chatStreamSchema = exports.aiFeedbackEndpoint = exports.aiFeedbackSchema = exports.forYouEndpoint = exports.fieldSuggestEndpoint = exports.fieldSuggestSchema = exports.chatClearEndpoint = exports.chatHistoryEndpoint = exports.chatSendEndpoint = exports.chatSchema = exports.skillExtractEndpoint = exports.skillExtractSchema = exports.atsHistoryEndpoint = exports.resumeRewriteEndpoint = exports.resumeRewriteSchema = exports.atsScoreEndpoint = exports.atsScoreSchema = exports.jobInsightEndpoint = exports.jobInsightSchema = exports.quotaStatusEndpoint = exports.usageHistoryEndpoint = exports.skillGapEndpoint = exports.skillGapSchema = exports.profileOptimizerEndpoint = exports.generateCoverLetterEndpoint = exports.coverLetterSchema = void 0;
const zod_1 = require("zod");
const Job_1 = require("../models/Job");
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const coverLetter_service_1 = require("../services/ai/coverLetter.service");
const profileOptimizer_service_1 = require("../services/ai/profileOptimizer.service");
const skillGap_service_1 = require("../services/ai/skillGap.service");
const jobInsight_service_1 = require("../services/ai/combined/jobInsight.service");
const atsScorer_service_1 = require("../services/ai/atsScorer.service");
const resumeRewriter_service_1 = require("../services/ai/resumeRewriter.service");
const assistant_service_1 = require("../services/ai/assistant.service");
const anticipatory_service_1 = require("../services/ai/anticipatory.service");
const fieldSuggester_service_1 = require("../services/ai/fieldSuggester.service");
const skillExtractor_service_1 = require("../services/ai/skillExtractor.service");
const usageLog_service_1 = require("../services/ai/usageLog.service");
const streamingChat_service_1 = require("../services/ai/streamingChat.service");
const assistant_service_2 = require("../services/ai/assistant.service");
const AiFeedback_1 = require("../models/AiFeedback");
const quota_service_1 = require("../services/ai/quota.service");
const aiCreditWeights_1 = require("../config/aiCreditWeights");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
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
    const userId = String(req.user._id);
    const user = await User_1.User.findById(userId);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const { jobId, tone, baseTemplate } = req.body;
    if (!isObjectId(jobId))
        throw ApiError_1.ApiError.badRequest('Invalid jobId');
    const job = await Job_1.Job.findById(jobId);
    if (!job)
        throw ApiError_1.ApiError.notFound('Job not found');
    const cached = await (0, coverLetter_service_1.hasCoverLetterCached)({
        userId,
        jobId,
        tone: tone,
    });
    const weight = (0, aiCreditWeights_1.getCreditWeight)('cover_letter');
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (!cached) {
        quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    }
    let result;
    try {
        result = await (0, coverLetter_service_1.generateCoverLetter)({ user, job, tone, baseTemplate });
    }
    catch (err) {
        if (!cached)
            await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!cached && !result.usedAi) {
        await (0, quota_service_1.refundQuota)(userId, weight);
    }
    res.json({ success: true, data: result, quota });
});
exports.profileOptimizerEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const forceRefresh = req.query.refresh === '1';
    const result = await (0, profileOptimizer_service_1.optimizeProfile)(user, { forceRefresh });
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
exports.usageHistoryEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const items = await (0, usageLog_service_1.getRecentUsageForUser)(userId, limit);
    res.json({ success: true, data: { items } });
});
exports.quotaStatusEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const snapshot = await (0, quota_service_1.getQuotaSnapshot)(String(req.user._id));
    res.json({ success: true, data: snapshot });
});
exports.jobInsightSchema = zod_1.z.object({
    body: zod_1.z.object({ jobId: zod_1.z.string().min(1) }),
});
exports.jobInsightEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const { jobId } = req.body;
    if (!isObjectId(jobId))
        throw ApiError_1.ApiError.badRequest('Invalid jobId');
    const [user, job] = await Promise.all([User_1.User.findById(userId), Job_1.Job.findById(jobId)]);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    if (!job)
        throw ApiError_1.ApiError.notFound('Job not found');
    const weight = (0, aiCreditWeights_1.getCreditWeight)('job_insight');
    const quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let insight;
    try {
        insight = await (0, jobInsight_service_1.runJobInsight)(user, job);
    }
    catch (err) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!insight) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        res.json({ success: true, data: null, message: 'AI unavailable', quota });
        return;
    }
    res.json({ success: true, data: insight, quota });
});
exports.atsScoreSchema = zod_1.z.object({
    body: zod_1.z.object({
        jobId: zod_1.z.string().optional(),
        refresh: zod_1.z.boolean().optional(),
    }),
});
exports.atsScoreEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const user = await User_1.User.findById(userId);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const resumeText = (user.profile.resumeText || '').trim();
    if (!resumeText || resumeText.length < 80) {
        throw ApiError_1.ApiError.badRequest('Upload a resume on your profile before running an ATS analysis.');
    }
    const { jobId, refresh } = req.body;
    let job = null;
    if (jobId) {
        if (!isObjectId(jobId))
            throw ApiError_1.ApiError.badRequest('Invalid jobId');
        job = await Job_1.Job.findById(jobId);
        if (!job)
            throw ApiError_1.ApiError.notFound('Job not found');
    }
    const cached = !refresh && (await (0, atsScorer_service_1.hasCachedAnalysis)(userId, resumeText, jobId));
    const weight = (0, aiCreditWeights_1.getCreditWeight)('ats_score');
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (!cached)
        quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, atsScorer_service_1.analyzeResume)(user, resumeText, {
            forceRefresh: !!refresh,
            job,
        });
    }
    catch (err) {
        if (!cached)
            await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!cached && !result.usedAi)
        await (0, quota_service_1.refundQuota)(userId, weight);
    res.json({ success: true, data: result, quota });
});
exports.resumeRewriteSchema = zod_1.z.object({
    body: zod_1.z.object({
        kind: zod_1.z.enum(['bullet', 'summary', 'achievement']),
        text: zod_1.z.string().min(5).max(1500),
        role: zod_1.z.string().max(80).optional(),
        tone: zod_1.z.enum(['professional', 'concise', 'impactful']).optional(),
    }),
});
exports.resumeRewriteEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const { kind, text, role, tone } = req.body;
    const cached = await (0, resumeRewriter_service_1.peekCachedRewrite)({ kind, text, role, tone });
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (cached) {
        res.json({
            success: true,
            data: {
                text: cached.text,
                alternates: cached.alternates,
                usedAi: true,
                cached: true,
            },
            quota,
        });
        return;
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)(`resume_rewrite:${kind}`);
    quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, resumeRewriter_service_1.rewriteResumeText)({ kind, text, role, tone, userId });
    }
    catch (err) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!result.usedAi)
        await (0, quota_service_1.refundQuota)(userId, weight);
    res.json({ success: true, data: result, quota });
});
exports.atsHistoryEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const history = await (0, atsScorer_service_1.listRecentAnalyses)(String(req.user._id), limit);
    res.json({ success: true, data: { history } });
});
exports.skillExtractSchema = zod_1.z.object({
    body: zod_1.z.object({
        text: zod_1.z.string().min(30).max(20000),
    }),
});
exports.skillExtractEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const { text } = req.body;
    const weight = (0, aiCreditWeights_1.getCreditWeight)('skill_extract');
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (weight > 0)
        quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, skillExtractor_service_1.extractSkills)(text, { userId });
    }
    catch (err) {
        if (weight > 0)
            await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (weight > 0 && (!result.usedAi || result.cached)) {
        await (0, quota_service_1.refundQuota)(userId, weight);
    }
    res.json({ success: true, data: result, quota });
});
exports.chatSchema = zod_1.z.object({
    body: zod_1.z.object({ message: zod_1.z.string().min(1).max(2000) }),
});
exports.chatSendEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const user = await User_1.User.findById(userId);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const { message } = req.body;
    const weight = (0, aiCreditWeights_1.getCreditWeight)('chat');
    const quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, assistant_service_1.sendChatMessage)(user, message);
    }
    catch (err) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    res.json({ success: true, data: result, quota });
});
exports.chatHistoryEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const history = await (0, assistant_service_1.getChatHistory)(String(req.user._id));
    res.json({ success: true, data: { history } });
});
exports.chatClearEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    await (0, assistant_service_1.clearChatHistory)(String(req.user._id));
    res.json({ success: true, message: 'Chat cleared' });
});
exports.fieldSuggestSchema = zod_1.z.object({
    body: zod_1.z.object({
        field: zod_1.z.enum([
            'headline',
            'summary',
            'skills',
            'preferredRoles',
            'preferredLocations',
            'preferredJobTypes',
            'experienceYears',
            'expectedSalary',
        ]),
    }),
});
exports.fieldSuggestEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const user = await User_1.User.findById(userId);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const { field } = req.body;
    const weight = (0, aiCreditWeights_1.getCreditWeight)('field_suggest');
    const quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, fieldSuggester_service_1.suggestField)(user, field);
    }
    catch (err) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!result) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        res.json({
            success: true,
            data: null,
            message: 'AI could not generate a value for this field',
            quota,
        });
        return;
    }
    res.json({ success: true, data: result, quota });
});
exports.forYouEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const force = req.query.refresh === '1';
    const cached = !force && (await (0, anticipatory_service_1.hasForYouCached)(userId));
    const weight = (0, aiCreditWeights_1.getCreditWeight)('for_you');
    let quota = await (0, quota_service_1.getQuotaSnapshot)(userId);
    if (!cached) {
        quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    }
    const user = await User_1.User.findById(userId);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    let result;
    try {
        result = await (0, anticipatory_service_1.getForYouRecommendations)(user, { forceRefresh: force });
    }
    catch (err) {
        if (!cached)
            await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!result && !cached) {
        await (0, quota_service_1.refundQuota)(userId, weight);
    }
    res.json({ success: true, data: result, quota });
});
exports.aiFeedbackSchema = zod_1.z.object({
    body: zod_1.z.object({
        feature: zod_1.z.string().min(2).max(60),
        refId: zod_1.z.string().min(1).max(64),
        rating: zod_1.z.union([zod_1.z.literal(-1), zod_1.z.literal(0), zod_1.z.literal(1)]),
        note: zod_1.z.string().max(1000).optional(),
    }),
});
exports.aiFeedbackEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const { feature, refId, rating, note } = req.body;
    await AiFeedback_1.AiFeedback.findOneAndUpdate({ user: userId, feature, refId }, {
        $set: { rating, note },
    }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ success: true });
});
exports.chatStreamSchema = zod_1.z.object({
    body: zod_1.z.object({ message: zod_1.z.string().min(1).max(2000) }),
});
exports.chatStreamEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    if (!(0, streamingChat_service_1.isGeminiStreamingAvailable)()) {
        throw new ApiError_1.ApiError(503, 'Streaming unavailable; use /ai/chat instead.');
    }
    const user = await User_1.User.findById(userId);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const { message } = req.body;
    const weight = (0, aiCreditWeights_1.getCreditWeight)('chat');
    const quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    const history = await (0, assistant_service_2.getChatHistory)(userId);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`event: quota\ndata: ${JSON.stringify(quota)}\n\n`);
    let refunded = false;
    const refundOnce = async () => {
        if (refunded)
            return;
        refunded = true;
        try {
            await (0, quota_service_1.refundQuota)(userId, weight);
        }
        catch {
        }
    };
    try {
        for await (const event of (0, streamingChat_service_1.streamChat)(user, message, history)) {
            if (event.chunk) {
                res.write(`event: chunk\ndata: ${JSON.stringify(event.chunk)}\n\n`);
            }
            if (event.final) {
                res.write(`event: done\ndata: ${JSON.stringify(event.final)}\n\n`);
            }
        }
    }
    catch (err) {
        await refundOnce();
        const msg = err.message;
        res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
    }
    finally {
        res.end();
    }
});
