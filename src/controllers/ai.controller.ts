import { Response } from 'express';
import { z } from 'zod';
import { Job } from '../models/Job';
import { User } from '../models/User';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest, SubscriptionTier } from '../types';
import { generateCoverLetter } from '../services/ai/coverLetter.service';
import { optimizeProfile } from '../services/ai/profileOptimizer.service';
import { analyseSkillGap } from '../services/ai/skillGap.service';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

// Cover letter is an Elite-equivalent feature per the doc. We allow
// Monthly + Yearly tiers (the SKUs that map to Pro / Elite in our scheme).
const ELIGIBLE_TIERS: SubscriptionTier[] = ['monthly', 'yearly'];

export const coverLetterSchema = z.object({
  body: z.object({
    jobId: z.string().min(1),
    tone: z
      .enum(['professional', 'friendly', 'technical'])
      .default('professional'),
    baseTemplate: z.string().max(4000).optional(),
  }),
});

export const generateCoverLetterEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();

    const user = await User.findById(req.user._id);
    if (!user) throw ApiError.notFound('User not found');

    if (!ELIGIBLE_TIERS.includes(user.subscription.tier as SubscriptionTier)) {
      throw ApiError.forbidden(
        'AI cover letters require a Pro or Elite plan. Upgrade to use this.',
      );
    }

    const { jobId, tone, baseTemplate } = req.body as z.infer<
      typeof coverLetterSchema
    >['body'];
    if (!isObjectId(jobId)) throw ApiError.badRequest('Invalid jobId');
    const job = await Job.findById(jobId);
    if (!job) throw ApiError.notFound('Job not found');

    const result = await generateCoverLetter({
      user,
      job,
      tone,
      baseTemplate,
    });
    res.json({ success: true, data: result });
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
    const result = await optimizeProfile(user);
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
