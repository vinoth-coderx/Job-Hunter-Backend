import { Response } from 'express';
import { z } from 'zod';
import { Job } from '../models/Job';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import {
  CoverLetterTone,
  generateCoverLetter,
  hasCoverLetterCached,
} from '../services/ai/coverLetter.service';
import { optimizeProfile } from '../services/ai/profileOptimizer.service';
import { analyseSkillGap } from '../services/ai/skillGap.service';
import { runJobInsight } from '../services/ai/combined/jobInsight.service';
import {
  clearChatHistory,
  getChatHistory,
  sendChatMessage,
} from '../services/ai/assistant.service';
import {
  getForYouRecommendations,
  hasForYouCached,
} from '../services/ai/anticipatory.service';
import {
  SuggestableField,
  suggestField,
} from '../services/ai/fieldSuggester.service';
import { enforceQuota, getQuotaSnapshot, refundQuota } from '../services/ai/quota.service';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

export const coverLetterSchema = z.object({
  body: z.object({
    jobId: z.string().min(1),
    tone: z
      .enum(['professional', 'friendly', 'technical'])
      .default('professional'),
    baseTemplate: z.string().max(4000).optional(),
  }),
});

/**
 * AI cover letter — open to every signed-in user. We rely on the daily
 * AI quota (per-user 30/day, global 400/day) to keep the free tier
 * sustainable instead of hard-gating by subscription. One quota slot per
 * generation; cached letters (same user, same job, same tone) are free.
 */
export const generateCoverLetterEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const { jobId, tone, baseTemplate } = req.body as z.infer<
      typeof coverLetterSchema
    >['body'];
    if (!isObjectId(jobId)) throw ApiError.badRequest('Invalid jobId');
    const job = await Job.findById(jobId);
    if (!job) throw ApiError.notFound('Job not found');

    // Skip quota when we know the letter is already cached — re-opening
    // a draft shouldn't cost. Only the FIRST generation per (job, tone)
    // pair charges a slot.
    const cached = await hasCoverLetterCached({
      userId,
      jobId,
      tone: tone as CoverLetterTone,
    });
    let quota = await getQuotaSnapshot(userId);
    if (!cached) {
      quota = await enforceQuota(userId);
    }

    let result;
    try {
      result = await generateCoverLetter({ user, job, tone, baseTemplate });
    } catch (err) {
      if (!cached) await refundQuota(userId);
      throw err;
    }
    // If we paid the quota but the model didn't run (no key, or it
    // errored to the deterministic fallback), refund the slot.
    if (!cached && !result.usedAi) {
      await refundQuota(userId);
    }
    res.json({ success: true, data: result, quota });
  },
);

/**
 * Profile optimiser — open to all signed-in users (free tier sees the
 * heuristic fallback when the LLM key isn't configured for their org;
 * paid tiers always get the LLM call). The endpoint is the same so the
 * Flutter UI doesn't need to branch.
 */
export const profileOptimizerEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const user = await User.findById(req.user._id);
    if (!user) throw ApiError.notFound('User not found');
    const forceRefresh = req.query.refresh === '1';
    const result = await optimizeProfile(user, { forceRefresh });
    res.json({ success: true, data: result });
  },
);

export const skillGapSchema = z.object({
  body: z.object({
    role: z.string().min(2).max(100),
    city: z.string().max(100).optional(),
  }),
});

export const skillGapEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const user = await User.findById(req.user._id);
    if (!user) throw ApiError.notFound('User not found');
    const { role, city } = req.body as z.infer<typeof skillGapSchema>['body'];
    const result = await analyseSkillGap(user, role, city);
    res.json({ success: true, data: result });
  },
);

export const quotaStatusEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const snapshot = await getQuotaSnapshot(String(req.user._id));
    res.json({ success: true, data: snapshot });
  },
);

export const jobInsightSchema = z.object({
  body: z.object({ jobId: z.string().min(1) }),
});

/**
 * Single-call job insight: match score + tailored cover letter + skill gap +
 * interview prep — all from one Gemini call. Counts as one quota slot;
 * refunds on failure. Cached by (userId, jobId) so repeated views don't
 * burn quota.
 */
export const jobInsightEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const { jobId } = req.body as z.infer<typeof jobInsightSchema>['body'];
    if (!isObjectId(jobId)) throw ApiError.badRequest('Invalid jobId');

    const [user, job] = await Promise.all([User.findById(userId), Job.findById(jobId)]);
    if (!user) throw ApiError.notFound('User not found');
    if (!job) throw ApiError.notFound('Job not found');

    const quota = await enforceQuota(userId);

    let insight;
    try {
      insight = await runJobInsight(user, job);
    } catch (err) {
      await refundQuota(userId);
      throw err;
    }

    if (!insight) {
      await refundQuota(userId);
      res.json({ success: true, data: null, message: 'AI unavailable', quota });
      return;
    }

    res.json({ success: true, data: insight, quota });
  },
);

export const chatSchema = z.object({
  body: z.object({ message: z.string().min(1).max(2000) }),
});

export const chatSendEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);
    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const { message } = req.body as z.infer<typeof chatSchema>['body'];

    const quota = await enforceQuota(userId);
    let result;
    try {
      result = await sendChatMessage(user, message);
    } catch (err) {
      await refundQuota(userId);
      throw err;
    }
    res.json({ success: true, data: result, quota });
  },
);

export const chatHistoryEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const history = await getChatHistory(String(req.user._id));
    res.json({ success: true, data: { history } });
  },
);

export const chatClearEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    await clearChatHistory(String(req.user._id));
    res.json({ success: true, message: 'Chat cleared' });
  },
);

export const fieldSuggestSchema = z.object({
  body: z.object({
    field: z.enum([
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

/**
 * Generate a concrete value for ONE profile field on demand. Used by the
 * Profile Coach "Generate" button when a suggestion arrived without a
 * pre-populated value. Returns the value the client can pipe straight
 * into AuthProvider.updateProfile.
 *
 * One quota slot per call; refunded on failure.
 */
export const fieldSuggestEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);
    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const { field } = req.body as z.infer<typeof fieldSuggestSchema>['body'];

    const quota = await enforceQuota(userId);
    let result;
    try {
      result = await suggestField(user, field as SuggestableField);
    } catch (err) {
      await refundQuota(userId);
      throw err;
    }

    if (!result) {
      await refundQuota(userId);
      res.json({
        success: true,
        data: null,
        message: 'AI could not generate a value for this field',
        quota,
      });
      return;
    }

    res.json({ success: true, data: result, quota });
  },
);

/**
 * Anticipatory "For You" home-screen recommendations. Cached 30 min per
 * user — only the first request per window burns a quota slot. Adding
 * `?refresh=1` forces a recompute (also burns a slot).
 */
export const forYouEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);
    const force = req.query.refresh === '1';

    // Cache hits don't call the model → skip quota enforcement.
    const cached = !force && (await hasForYouCached(userId));

    let quota = await getQuotaSnapshot(userId);
    if (!cached) {
      quota = await enforceQuota(userId);
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    let result;
    try {
      result = await getForYouRecommendations(user, { forceRefresh: force });
    } catch (err) {
      if (!cached) await refundQuota(userId);
      throw err;
    }

    if (!result && !cached) {
      await refundQuota(userId);
    }

    res.json({ success: true, data: result, quota });
  },
);
