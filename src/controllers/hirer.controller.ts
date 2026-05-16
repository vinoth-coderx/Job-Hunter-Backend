import { Response } from 'express';
import { z } from 'zod';
import { HirerProfile, IHirerProfile } from '../models/HirerProfile';
import { Job } from '../models/Job';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import {
  CLOUDINARY_FOLDERS,
  destroyAsset,
  isCloudinaryConfigured,
  publicIdFromUrl,
  uploadBuffer,
} from '../config/cloudinary';
import { generateCompanyDescription } from '../services/ai/companyDescription.service';
import { enforceQuota, refundQuota } from '../services/ai/quota.service';
import { getCreditWeight } from '../config/aiCreditWeights';

// ─────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────

const otherLocationSchema = z.object({
  city: z.string().min(1).max(100),
  state: z.string().max(100).optional(),
});

const headquartersSchema = z.object({
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  address: z.string().max(500).optional(),
});

const socialLinksSchema = z.object({
  linkedin: z.string().url().max(500).optional().or(z.literal('').transform(() => undefined)),
  twitter: z.string().url().max(500).optional().or(z.literal('').transform(() => undefined)),
  glassdoor: z.string().url().max(500).optional().or(z.literal('').transform(() => undefined)),
});

export const createHirerProfileSchema = z.object({
  body: z.object({
    companyName: z.string().min(2).max(200),
    industry: z.string().max(100).optional(),
    companySize: z
      .enum(['1-10', '11-50', '51-200', '201-500', '500-1000', '1000+'])
      .optional(),
    foundedYear: z.coerce.number().int().min(1800).max(new Date().getFullYear()).optional(),
    website: z.string().url().max(500).optional().or(z.literal('').transform(() => undefined)),
    description: z.string().max(5000).optional(),
    cultureValues: z.string().max(5000).optional(),
    headquarters: headquartersSchema.optional(),
    otherLocations: z.array(otherLocationSchema).max(20).optional(),
    socialLinks: socialLinksSchema.optional(),
  }),
});

export const updateHirerProfileSchema = createHirerProfileSchema.deepPartial();

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const requireUser = (req: AuthRequest): { id: string } => {
  if (!req.user) throw ApiError.unauthorized();
  return { id: req.user.id };
};

const sanitiseProfile = (p: IHirerProfile) => ({
  id: p._id.toString(),
  companyName: p.companyName,
  companyLogoUrl: p.companyLogoUrl,
  industry: p.industry,
  companySize: p.companySize,
  foundedYear: p.foundedYear,
  website: p.website,
  description: p.description,
  cultureValues: p.cultureValues,
  officePhotos: p.officePhotos,
  headquarters: p.headquarters,
  otherLocations: p.otherLocations,
  socialLinks: p.socialLinks,
  verification: p.verification,
  rating: p.rating,
  followersCount: p.followersCount,
  hirerSubscription: p.hirerSubscription,
  // Trust signals consumed by SafeApplyBadge / FraudWarningBanner on
  // the seeker side. `approvalStatus` distinguishes "pending review"
  // and "suspended" companies so the UI can warn without leaking the
  // recruiter's email or any moderation detail.
  approvalStatus: p.approvalStatus,
  trustScore: p.trustScore,
  dailyPostLimit: p.dailyPostLimit,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

// ─────────────────────────────────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────────────────────────────────

export const getMyHirerProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = requireUser(req);
  const profile = await HirerProfile.findOne({ user: id });
  if (!profile) {
    res.json({ success: true, data: null });
    return;
  }
  res.json({ success: true, data: sanitiseProfile(profile) });
});

export const createHirerProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = requireUser(req);

  const existing = await HirerProfile.findOne({ user: id });
  if (existing) throw ApiError.conflict('Hirer profile already exists; use PUT to update');

  const body = req.body as z.infer<typeof createHirerProfileSchema>['body'];
  const profile = await HirerProfile.create({
    user: id,
    ...body,
    verification: { isVerified: false },
    rating: { average: 0, totalReviews: 0 },
    followersCount: 0,
    teamMembers: [],
    hirerSubscription: { plan: 'free', status: 'active' },
  });

  res.status(201).json({ success: true, data: sanitiseProfile(profile) });
});

export const updateHirerProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = requireUser(req);
  const profile = await HirerProfile.findOne({ user: id });
  if (!profile) throw ApiError.notFound('Hirer profile not found');

  const body = req.body as Partial<z.infer<typeof createHirerProfileSchema>['body']>;

  // Whitelist updatable fields — never let the client touch verification,
  // rating, followers, hirerSubscription, teamMembers via this endpoint.
  const updatable: (keyof IHirerProfile)[] = [
    'companyName',
    'industry',
    'companySize',
    'foundedYear',
    'website',
    'description',
    'cultureValues',
    'headquarters',
    'otherLocations',
    'socialLinks',
  ];
  for (const key of updatable) {
    if (body[key as keyof typeof body] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (profile as any)[key] = body[key as keyof typeof body];
    }
  }

  await profile.save();
  res.json({ success: true, data: sanitiseProfile(profile) });
});

export const uploadHirerLogo = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = requireUser(req);
  if (!req.file || !req.file.buffer) {
    throw ApiError.badRequest('No file uploaded — field name must be "logo"');
  }
  if (!isCloudinaryConfigured()) {
    throw ApiError.internal('Cloudinary is not configured on the server');
  }

  const profile = await HirerProfile.findOne({ user: id });
  if (!profile) throw ApiError.notFound('Hirer profile not found — create it first');

  const oldPublicId = profile.companyLogoPublicId;

  const result = await uploadBuffer(req.file.buffer, {
    folder: CLOUDINARY_FOLDERS.COMPANY_LOGO,
    publicId: `hirer_${profile._id.toString()}`,
    resourceType: 'image',
    overwrite: true,
    tags: ['company-logo', `hirer:${profile._id.toString()}`],
  });

  profile.companyLogoUrl = result.url;
  profile.companyLogoPublicId = result.publicId;
  await profile.save();

  if (oldPublicId && oldPublicId !== result.publicId) {
    await destroyAsset(oldPublicId, 'image');
  }

  res.status(201).json({ success: true, data: { logoUrl: profile.companyLogoUrl } });
});

export const uploadOfficePhotos = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = requireUser(req);
  // Local shape to avoid relying on `@types/multer`'s Express namespace
  // augmentation — which Render's prod install sometimes drops.
  type UploadedFile = {
    fieldname: string;
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  };
  const files = (req.files as UploadedFile[] | undefined) ?? [];
  if (files.length === 0) {
    throw ApiError.badRequest('No files uploaded — field name must be "photos"');
  }
  if (!isCloudinaryConfigured()) {
    throw ApiError.internal('Cloudinary is not configured on the server');
  }

  const profile = await HirerProfile.findOne({ user: id });
  if (!profile) throw ApiError.notFound('Hirer profile not found — create it first');

  const tag = `hirer:${profile._id.toString()}`;
  const uploads = await Promise.all(
    files.map((f) =>
      uploadBuffer(f.buffer, {
        folder: CLOUDINARY_FOLDERS.OFFICE_PHOTO,
        resourceType: 'image',
        // Let Cloudinary mint a unique id per photo.
        tags: ['office-photo', tag],
      }),
    ),
  );
  const newUrls = uploads.map((u) => u.url);

  // Cap at 10 photos total — drop oldest if over.
  const combined = [...profile.officePhotos, ...newUrls];
  const merged = combined.slice(-10);
  const removed = combined.slice(0, combined.length - merged.length);
  profile.officePhotos = merged;
  await profile.save();

  await Promise.all(
    removed
      .map((u) => publicIdFromUrl(u))
      .filter((p): p is string => !!p)
      .map((p) => destroyAsset(p, 'image')),
  );

  res.status(201).json({ success: true, data: { officePhotos: profile.officePhotos } });
});

/**
 * Delete a single office photo by public_id. The route still uses
 * `:filename` as the URL segment for backward compatibility with the
 * client, but it now expects a Cloudinary public_id (the path under
 * the bucket — e.g. `job_hunter/office_photos/abc123`). Clients that
 * pass a full URL get parsed via [publicIdFromUrl].
 */
export const deleteOfficePhoto = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = requireUser(req);
  const raw = String(req.params.filename || '').trim();
  if (!raw) throw ApiError.badRequest('Missing public_id');

  const profile = await HirerProfile.findOne({ user: id });
  if (!profile) throw ApiError.notFound('Hirer profile not found');

  const targetPid = raw.startsWith('http') ? publicIdFromUrl(raw) : raw;
  if (!targetPid) throw ApiError.badRequest('Could not resolve public_id');

  const before = profile.officePhotos.length;
  profile.officePhotos = profile.officePhotos.filter((u) => publicIdFromUrl(u) !== targetPid);
  if (before === profile.officePhotos.length) throw ApiError.notFound('Photo not in profile');
  await profile.save();
  await destroyAsset(targetPid, 'image');

  res.json({ success: true, data: { officePhotos: profile.officePhotos } });
});

// ─────────────────────────────────────────────────────────────────────────
// Public company profile (seeker-facing)
// ─────────────────────────────────────────────────────────────────────────

export const getPublicCompanyProfile = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = String(req.params.id || '');
  const profile = await HirerProfile.findById(id);
  if (!profile) throw ApiError.notFound('Company not found');

  const activeJobsCount = await Job.countDocuments({
    hirerProfile: profile._id,
    status: 'active',
    isActive: true,
  });

  res.json({
    success: true,
    data: {
      ...sanitiseProfile(profile),
      activeJobsCount,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Hirer dashboard stats
// ─────────────────────────────────────────────────────────────────────────

export const getHirerStats = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = requireUser(req);
  const profile = await HirerProfile.findOne({ user: id });
  if (!profile) {
    res.json({
      success: true,
      data: {
        hasProfile: false,
        activeJobs: 0,
        draftJobs: 0,
        closedJobs: 0,
        totalApplications: 0,
        totalShortlisted: 0,
      },
    });
    return;
  }

  const [activeJobs, draftJobs, closedJobs, agg] = await Promise.all([
    Job.countDocuments({ hirerProfile: profile._id, status: 'active', isNative: true }),
    Job.countDocuments({ hirerProfile: profile._id, status: 'draft', isNative: true }),
    Job.countDocuments({ hirerProfile: profile._id, status: 'closed', isNative: true }),
    Job.aggregate([
      { $match: { hirerProfile: profile._id, isNative: true } },
      {
        $group: {
          _id: null,
          totalApplications: { $sum: '$applicationsCount' },
          totalShortlisted: { $sum: '$shortlistedCount' },
        },
      },
    ]),
  ]);

  res.json({
    success: true,
    data: {
      hasProfile: true,
      hirerProfileId: profile._id.toString(),
      companyName: profile.companyName,
      isVerified: profile.verification.isVerified,
      activeJobs,
      draftJobs,
      closedJobs,
      totalApplications: agg[0]?.totalApplications ?? 0,
      totalShortlisted: agg[0]?.totalShortlisted ?? 0,
    },
  });
});

export const generateCompanyDescriptionSchema = z.object({
  body: z.object({
    companyName: z.string().min(2).max(200).optional(),
    industry: z.string().max(120).optional(),
    sizeBand: z.string().max(60).optional(),
    hqLocation: z.string().max(120).optional(),
    whatYouDo: z.string().max(2000).optional(),
    toneHint: z.enum(['professional', 'casual', 'startup']).optional(),
  }),
});

/**
 * AI-draft the "About" section for the hirer onboarding/edit screen.
 * Pulls companyName from the existing profile when present so the
 * hirer doesn't have to re-type it; falls back to the body field for
 * first-time setup before save. One quota slot, refunded on failure.
 */
export const generateCompanyDescriptionEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const userId = String(req.user._id);

    const body = req.body as z.infer<typeof generateCompanyDescriptionSchema>['body'];

    let companyName = (body.companyName || '').trim();
    if (!companyName) {
      const profile = await HirerProfile.findOne({ user: userId })
        .select('companyName')
        .lean();
      companyName = profile?.companyName?.trim() || '';
    }
    if (companyName.length < 2) {
      throw ApiError.badRequest('Company name is required to generate a description');
    }

    const weight = getCreditWeight('company_description');
    const quota = await enforceQuota(userId, weight);

    let result;
    try {
      result = await generateCompanyDescription(
        {
          companyName,
          industry: body.industry,
          sizeBand: body.sizeBand,
          hqLocation: body.hqLocation,
          whatYouDo: body.whatYouDo,
          toneHint: body.toneHint,
        },
        { userId },
      );
    } catch (err) {
      await refundQuota(userId, weight);
      throw err;
    }

    if (!result.usedAi) {
      await refundQuota(userId, weight);
    }

    res.json({
      success: true,
      data: result,
      quota,
    });
  },
);
