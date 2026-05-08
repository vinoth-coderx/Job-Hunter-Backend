import { Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { HirerProfile } from '../models/HirerProfile';
import { CompanyFollow } from '../models/CompanyFollow';
import { CompanyReview } from '../models/CompanyReview';
import { Job } from '../models/Job';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';

const isObjectId = (s: string) => /^[a-f0-9]{24}$/i.test(s);

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

const ratingsSchema = z.object({
  overall: z.number().min(1).max(5),
  culture: z.number().min(1).max(5).optional(),
  workLifeBalance: z.number().min(1).max(5).optional(),
  growth: z.number().min(1).max(5).optional(),
  pay: z.number().min(1).max(5).optional(),
  management: z.number().min(1).max(5).optional(),
});

export const reviewSchema = z.object({
  body: z.object({
    isAnonymous: z.boolean().default(true),
    reviewerRole: z.enum(['candidate', 'employee', 'ex_employee']),
    ratings: ratingsSchema,
    title: z.string().max(200).optional(),
    pros: z.string().max(4000).optional(),
    cons: z.string().max(4000).optional(),
    adviceToManagement: z.string().max(4000).optional(),
    interviewExperience: z
      .object({
        difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
        result: z.enum(['got_offer', 'rejected', 'withdrew']).optional(),
        description: z.string().max(4000).optional(),
      })
      .optional(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────
// Public — company browsing (re-exposed under /companies for clarity)
// ─────────────────────────────────────────────────────────────────────────

export const getCompanyProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid company id');

  const profile = await HirerProfile.findById(id).lean();
  if (!profile) throw ApiError.notFound('Company not found');

  const [activeJobsCount, isFollowing] = await Promise.all([
    Job.countDocuments({
      hirerProfile: profile._id,
      status: 'active',
      isActive: true,
      isNative: true,
    }),
    req.user
      ? CompanyFollow.findOne({
          user: req.user._id,
          hirerProfile: profile._id,
        }).select('_id').lean().then((f) => !!f)
      : Promise.resolve(false),
  ]);

  res.json({
    success: true,
    data: {
      id: profile._id.toString(),
      companyName: profile.companyName,
      companyLogoUrl: profile.companyLogoUrl,
      industry: profile.industry,
      companySize: profile.companySize,
      foundedYear: profile.foundedYear,
      website: profile.website,
      description: profile.description,
      cultureValues: profile.cultureValues,
      officePhotos: profile.officePhotos,
      headquarters: profile.headquarters,
      otherLocations: profile.otherLocations,
      socialLinks: profile.socialLinks,
      verification: profile.verification,
      rating: profile.rating,
      followersCount: profile.followersCount,
      activeJobsCount,
      isFollowing,
    },
  });
});

export const listCompanyJobs = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid company id');

  const items = await Job.find({
    hirerProfile: id,
    status: 'active',
    isActive: true,
    isNative: true,
  })
    .sort({ publishedAt: -1, postedAt: -1 })
    .limit(50)
    .lean();
  res.json({ success: true, data: items });
});

// ─────────────────────────────────────────────────────────────────────────
// Follow
// ─────────────────────────────────────────────────────────────────────────

export const followCompany = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid company id');

  const profile = await HirerProfile.findById(id).select('_id').lean();
  if (!profile) throw ApiError.notFound('Company not found');

  try {
    await CompanyFollow.create({
      user: req.user._id,
      hirerProfile: new mongoose.Types.ObjectId(id),
    });
    await HirerProfile.updateOne({ _id: id }, { $inc: { followersCount: 1 } });
    res.status(201).json({ success: true, message: 'Following' });
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: number }).code === 11000
    ) {
      res.json({ success: true, message: 'Already following' });
      return;
    }
    throw err;
  }
});

export const unfollowCompany = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid company id');

  const result = await CompanyFollow.deleteOne({
    user: req.user._id,
    hirerProfile: new mongoose.Types.ObjectId(id),
  });
  if (result.deletedCount > 0) {
    await HirerProfile.updateOne(
      { _id: id, followersCount: { $gt: 0 } },
      { $inc: { followersCount: -1 } },
    );
  }
  res.json({ success: true, message: 'Unfollowed' });
});

export const listFollowedCompanies = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const items = await CompanyFollow.find({ user: req.user._id })
    .sort({ followedAt: -1 })
    .populate({
      path: 'hirerProfile',
      select:
        'companyName companyLogoUrl industry rating followersCount verification',
    })
    .lean();
  const list = items
    .map((i) => i.hirerProfile)
    .filter((c): c is NonNullable<typeof c> => c !== null);
  res.json({ success: true, data: list });
});

// ─────────────────────────────────────────────────────────────────────────
// Reviews
// ─────────────────────────────────────────────────────────────────────────

const recomputeRating = async (hirerProfileId: mongoose.Types.ObjectId) => {
  const docs = await CompanyReview.find({
    hirerProfile: hirerProfileId,
    isApproved: true,
  })
    .select('ratings.overall')
    .lean();
  if (docs.length === 0) {
    await HirerProfile.updateOne(
      { _id: hirerProfileId },
      { $set: { 'rating.average': 0, 'rating.totalReviews': 0 } },
    );
    return;
  }
  const sum = docs.reduce((s, r) => s + (r.ratings?.overall ?? 0), 0);
  const avg = Math.round((sum / docs.length) * 10) / 10;
  await HirerProfile.updateOne(
    { _id: hirerProfileId },
    {
      $set: {
        'rating.average': avg,
        'rating.totalReviews': docs.length,
      },
    },
  );
};

export const submitReview = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid company id');

  const profile = await HirerProfile.findById(id).select('_id user').lean();
  if (!profile) throw ApiError.notFound('Company not found');
  if (profile.user.toString() === req.user.id) {
    throw ApiError.forbidden('You cannot review your own company');
  }

  const body = req.body as z.infer<typeof reviewSchema>['body'];

  // Upsert one review per (user, company).
  await CompanyReview.findOneAndUpdate(
    { hirerProfile: profile._id, user: req.user._id },
    {
      $set: {
        hirerProfile: profile._id,
        user: req.user._id,
        isAnonymous: body.isAnonymous,
        reviewerRole: body.reviewerRole,
        ratings: body.ratings,
        title: body.title,
        pros: body.pros,
        cons: body.cons,
        adviceToManagement: body.adviceToManagement,
        interviewExperience: body.interviewExperience,
        isApproved: true,
      },
    },
    { upsert: true, new: true },
  );

  await recomputeRating(profile._id);

  res.status(201).json({ success: true, message: 'Review submitted' });
});

export const listReviews = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = String(req.params.id);
  if (!isObjectId(id)) throw ApiError.badRequest('Invalid company id');

  const reviews = await CompanyReview.find({
    hirerProfile: new mongoose.Types.ObjectId(id),
    isApproved: true,
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate({ path: 'user', select: 'profile.fullName profile.avatar' })
    .lean();

  // Strip user when anonymous so reviewer identity never leaks.
  const sanitised = reviews.map((r) => ({
    id: r._id.toString(),
    isAnonymous: r.isAnonymous,
    reviewerRole: r.reviewerRole,
    reviewer: r.isAnonymous
      ? null
      : {
          fullName:
            (r.user as unknown as
              | { profile?: { fullName?: string; avatar?: string } }
              | null)?.profile?.fullName ?? null,
          avatar:
            (r.user as unknown as
              | { profile?: { fullName?: string; avatar?: string } }
              | null)?.profile?.avatar ?? null,
        },
    ratings: r.ratings,
    title: r.title,
    pros: r.pros,
    cons: r.cons,
    adviceToManagement: r.adviceToManagement,
    interviewExperience: r.interviewExperience,
    helpfulCount: r.helpfulCount,
    createdAt: r.createdAt,
  }));

  res.json({ success: true, data: sanitised });
});
