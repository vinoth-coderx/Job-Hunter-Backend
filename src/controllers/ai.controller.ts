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
  analyzeResume,
  hasCachedAnalysis,
  listRecentAnalyses,
} from '../services/ai/atsScorer.service';
import {
  peekCachedRewrite,
  rewriteResumeText,
} from '../services/ai/resumeRewriter.service';
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
import { extractSkills } from '../services/ai/skillExtractor.service';
import { getRecentUsageForUser } from '../services/ai/usageLog.service';
import {
  isGeminiStreamingAvailable,
  streamChat,
} from '../services/ai/streamingChat.service';
import { getChatHistory as getStreamHistory } from '../services/ai/assistant.service';
import { AiFeedback } from '../models/AiFeedback';
import { enforceQuota, getQuotaSnapshot, refundQuota } from '../services/ai/quota.service';
import { getCreditWeight } from '../config/aiCreditWeights';

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
    const weight = getCreditWeight('cover_letter');
    let quota = await getQuotaSnapshot(userId);
    if (!cached) {
      quota = await enforceQuota(userId, weight);
    }

    let result;
    try {
      result = await generateCoverLetter({ user, job, tone, baseTemplate });
    } catch (err) {
      if (!cached) await refundQuota(userId, weight);
      throw err;
    }
    // If we paid the quota but the model didn't run (no key, or it
    // errored to the deterministic fallback), refund the slots.
    if (!cached && !result.usedAi) {
      await refundQuota(userId, weight);
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

/**
 * Per-user AI usage history for the Flutter "my AI activity" page.
 * Returns the most recent rows for the calling user — capped at 200 to
 * keep the payload small. The 90d collection TTL means rows older than
 * that drop out naturally; pagination is intentionally not exposed here
 * because the audience (the user themselves) only cares about recent
 * activity.
 */
export const usageHistoryEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const items = await getRecentUsageForUser(userId, limit);
    res.json({ success: true, data: { items } });
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

    const weight = getCreditWeight('job_insight');
    const quota = await enforceQuota(userId, weight);

    let insight;
    try {
      insight = await runJobInsight(user, job);
    } catch (err) {
      await refundQuota(userId, weight);
      throw err;
    }

    if (!insight) {
      await refundQuota(userId, weight);
      res.json({ success: true, data: null, message: 'AI unavailable', quota });
      return;
    }

    res.json({ success: true, data: insight, quota });
  },
);

export const atsScoreSchema = z.object({
  body: z.object({
    jobId: z.string().optional(),
    refresh: z.boolean().optional(),
  }),
});

/**
 * ATS resume score. Generic if jobId is omitted, otherwise tailored to
 * that job's keyword set. Costs ONE quota slot per fresh analysis;
 * cached results (same resume + same job, same user) return instantly
 * without burning a slot. Refunds the slot if the model didn't run.
 */
export const atsScoreEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const resumeText = (user.profile.resumeText || '').trim();
    if (!resumeText || resumeText.length < 80) {
      throw ApiError.badRequest(
        'Upload a resume on your profile before running an ATS analysis.',
      );
    }

    const { jobId, refresh } = req.body as z.infer<typeof atsScoreSchema>['body'];
    let job = null;
    if (jobId) {
      if (!isObjectId(jobId)) throw ApiError.badRequest('Invalid jobId');
      job = await Job.findById(jobId);
      if (!job) throw ApiError.notFound('Job not found');
    }

    // Cache check first — if we already analysed this exact (resume, job)
    // pair for this user, we don't burn a quota slot.
    const cached = !refresh && (await hasCachedAnalysis(userId, resumeText, jobId));
    const weight = getCreditWeight('ats_score');
    let quota = await getQuotaSnapshot(userId);
    if (!cached) quota = await enforceQuota(userId, weight);

    let result;
    try {
      result = await analyzeResume(user, resumeText, {
        forceRefresh: !!refresh,
        job,
      });
    } catch (err) {
      if (!cached) await refundQuota(userId, weight);
      throw err;
    }
    // If we paid the quota but no AI ran (key missing, parser fallback),
    // refund the slots so heuristic responses are free.
    if (!cached && !result.usedAi) await refundQuota(userId, weight);

    res.json({ success: true, data: result, quota });
  },
);

export const resumeRewriteSchema = z.object({
  body: z.object({
    kind: z.enum(['bullet', 'summary', 'achievement']),
    text: z.string().min(5).max(1500),
    role: z.string().max(80).optional(),
    tone: z.enum(['professional', 'concise', 'impactful']).optional(),
  }),
});

/**
 * Rewrite a single resume bullet / summary / achievement line. Routed
 * through Groq (cheap, fast); cache hits don't burn a slot. The endpoint
 * returns the primary rewrite plus 0-3 alternative phrasings the user
 * can pick from.
 */
export const resumeRewriteEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const { kind, text, role, tone } = req.body as z.infer<
      typeof resumeRewriteSchema
    >['body'];

    // Cheap Redis cache probe so a cache hit doesn't burn a quota slot.
    const cached = await peekCachedRewrite({ kind, text, role, tone });
    let quota = await getQuotaSnapshot(userId);
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

    const weight = getCreditWeight(`resume_rewrite:${kind}`);
    quota = await enforceQuota(userId, weight);
    let result;
    try {
      result = await rewriteResumeText({ kind, text, role, tone, userId });
    } catch (err) {
      await refundQuota(userId, weight);
      throw err;
    }
    if (!result.usedAi) await refundQuota(userId, weight);

    res.json({ success: true, data: result, quota });
  },
);

export const atsHistoryEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const history = await listRecentAnalyses(String(req.user._id), limit);
    res.json({ success: true, data: { history } });
  },
);

export const skillExtractSchema = z.object({
  body: z.object({
    text: z.string().min(30).max(20000),
  }),
});

/**
 * Skill extraction endpoint — paste any text (JD, resume snippet, role
 * description) and get a normalised list of skills back. Routed through
 * Groq (cheap, fast) and cached 7d server-side, so the same input never
 * burns a fresh call. One quota slot per fresh extraction; cached hits
 * are free.
 */
export const skillExtractEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);
    const { text } = req.body as z.infer<typeof skillExtractSchema>['body'];

    const weight = getCreditWeight('skill_extract');
    let quota = await getQuotaSnapshot(userId);
    if (weight > 0) quota = await enforceQuota(userId, weight);

    let result;
    try {
      result = await extractSkills(text, { userId });
    } catch (err) {
      if (weight > 0) await refundQuota(userId, weight);
      throw err;
    }
    // Refund when nothing ran (e.g. AI unavailable, fallback) or when a
    // cache hit short-circuited the call.
    if (weight > 0 && (!result.usedAi || result.cached)) {
      await refundQuota(userId, weight);
    }

    res.json({ success: true, data: result, quota });
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

    const weight = getCreditWeight('chat');
    const quota = await enforceQuota(userId, weight);
    let result;
    try {
      result = await sendChatMessage(user, message);
    } catch (err) {
      await refundQuota(userId, weight);
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

    const weight = getCreditWeight('field_suggest');
    const quota = await enforceQuota(userId, weight);
    let result;
    try {
      result = await suggestField(user, field as SuggestableField);
    } catch (err) {
      await refundQuota(userId, weight);
      throw err;
    }

    if (!result) {
      await refundQuota(userId, weight);
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
    const weight = getCreditWeight('for_you');

    let quota = await getQuotaSnapshot(userId);
    if (!cached) {
      quota = await enforceQuota(userId, weight);
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    let result;
    try {
      result = await getForYouRecommendations(user, { forceRefresh: force });
    } catch (err) {
      if (!cached) await refundQuota(userId, weight);
      throw err;
    }

    if (!result && !cached) {
      await refundQuota(userId, weight);
    }

    res.json({ success: true, data: result, quota });
  },
);

export const aiFeedbackSchema = z.object({
  body: z.object({
    feature: z.string().min(2).max(60),
    refId: z.string().min(1).max(64),
    rating: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    note: z.string().max(1000).optional(),
  }),
});

/**
 * Per-user feedback on an AI output (chat reply, ATS score, applicant
 * rank etc). Generic across features — the producing surface decides
 * what `feature` and `refId` mean. Upserts so the latest opinion wins.
 *
 * No quota cost (weight 0); admin analytics aggregates ratings to spot
 * which features regress over time.
 */
export const aiFeedbackEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const { feature, refId, rating, note } = req.body as z.infer<
      typeof aiFeedbackSchema
    >['body'];

    await AiFeedback.findOneAndUpdate(
      { user: userId, feature, refId },
      {
        $set: { rating, note },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.json({ success: true });
  },
);

export const chatStreamSchema = z.object({
  body: z.object({ message: z.string().min(1).max(2000) }),
});

/**
 * Server-Sent Events streaming chat. Yields incremental text deltas as
 * Gemini produces them, then a final `done` event with the assembled
 * reply + token usage. Falls back gracefully when Gemini isn't
 * configured — clients should keep using `/ai/chat` as the regular
 * non-streaming endpoint.
 *
 * Quota model: debits ONE chat slot up-front (same as `/ai/chat`),
 * refunds on stream errors. Token usage is logged via recordAiUsage
 * in the stream service.
 */
export const chatStreamEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    if (!isGeminiStreamingAvailable()) {
      throw new ApiError(
        503,
        'Streaming unavailable; use /ai/chat instead.',
      );
    }

    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');

    const { message } = req.body as z.infer<typeof chatStreamSchema>['body'];

    // Debit quota BEFORE opening the stream so we can return a clean
    // 429 with the quota payload. SSE responses can't carry an error
    // body the client parses easily, so quota errors should fail the
    // initial request, not mid-stream.
    const weight = getCreditWeight('chat');
    const quota = await enforceQuota(userId, weight);

    const history = await getStreamHistory(userId);

    // Open SSE response. Disable nginx buffering so chunks reach the
    // client without batching, and disable response compression for
    // the same reason (compressed streams batch by definition).
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Send the initial quota snapshot so the client can update its
    // banner without a separate /ai/quota fetch after the stream ends.
    res.write(
      `event: quota\ndata: ${JSON.stringify(quota)}\n\n`,
    );

    let refunded = false;
    const refundOnce = async () => {
      if (refunded) return;
      refunded = true;
      try {
        await refundQuota(userId, weight);
      } catch {
        // best-effort
      }
    };

    try {
      for await (const event of streamChat(user, message, history)) {
        if (event.chunk) {
          res.write(
            `event: chunk\ndata: ${JSON.stringify(event.chunk)}\n\n`,
          );
        }
        if (event.final) {
          res.write(
            `event: done\ndata: ${JSON.stringify(event.final)}\n\n`,
          );
        }
      }
    } catch (err) {
      await refundOnce();
      const msg = (err as Error).message;
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`,
      );
    } finally {
      res.end();
    }
  },
);
