import { Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { z } from 'zod';
import { HirerProfile, IHirerProfile } from '../models/HirerProfile';
import { Job } from '../models/Job';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { COMPANY_LOGO_DIR, OFFICE_PHOTO_DIR } from '../middleware/upload';

const removeFileQuiet = async (dir: string, filename?: string): Promise<void> => {
  if (!filename) return;
  try {
    await fs.unlink(path.join(dir, filename));
  } catch {
    // already gone
  }
};

const filenameFromUrl = (url?: string): string | undefined => {
  if (!url) return undefined;
  const last = url.split('/').filter(Boolean).pop();
  return last || undefined;
};

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
  if (!req.file) throw ApiError.badRequest('No file uploaded — field name must be "logo"');

  const profile = await HirerProfile.findOne({ user: id });
  if (!profile) {
    await removeFileQuiet(COMPANY_LOGO_DIR, req.file.filename);
    throw ApiError.notFound('Hirer profile not found — create it first');
  }

  const old = filenameFromUrl(profile.companyLogoUrl);
  profile.companyLogoUrl = `/api/v1/hirer/profile/logo/${profile._id.toString()}/${req.file.filename}`;
  await profile.save();
  if (old && old !== req.file.filename) await removeFileQuiet(COMPANY_LOGO_DIR, old);

  res.status(201).json({ success: true, data: { logoUrl: profile.companyLogoUrl } });
});

export const getHirerLogo = asyncHandler(async (req: AuthRequest, res: Response) => {
  const filename = String(req.params.filename || '');
  // Disallow path traversal — only basename allowed.
  if (!filename || filename.includes('/') || filename.includes('..')) {
    throw ApiError.badRequest('Invalid filename');
  }
  const filePath = path.join(COMPANY_LOGO_DIR, filename);
  try {
    await fs.access(filePath);
  } catch {
    throw ApiError.notFound('Logo not found');
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

export const uploadOfficePhotos = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = requireUser(req);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) {
    throw ApiError.badRequest('No files uploaded — field name must be "photos"');
  }

  const profile = await HirerProfile.findOne({ user: id });
  if (!profile) {
    await Promise.all(files.map((f) => removeFileQuiet(OFFICE_PHOTO_DIR, f.filename)));
    throw ApiError.notFound('Hirer profile not found — create it first');
  }

  const newUrls = files.map(
    (f) => `/api/v1/hirer/profile/photo/${profile._id.toString()}/${f.filename}`,
  );
  // Cap at 10 photos total — drop oldest if over.
  const merged = [...profile.officePhotos, ...newUrls].slice(-10);
  const removed = [...profile.officePhotos, ...newUrls].slice(0, -10);
  profile.officePhotos = merged;
  await profile.save();

  await Promise.all(removed.map((u) => removeFileQuiet(OFFICE_PHOTO_DIR, filenameFromUrl(u))));

  res.status(201).json({ success: true, data: { officePhotos: profile.officePhotos } });
});

export const getOfficePhoto = asyncHandler(async (req: AuthRequest, res: Response) => {
  const filename = String(req.params.filename || '');
  if (!filename || filename.includes('/') || filename.includes('..')) {
    throw ApiError.badRequest('Invalid filename');
  }
  const filePath = path.join(OFFICE_PHOTO_DIR, filename);
  try {
    await fs.access(filePath);
  } catch {
    throw ApiError.notFound('Photo not found');
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

export const deleteOfficePhoto = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = requireUser(req);
  const filename = String(req.params.filename || '');
  if (!filename || filename.includes('/') || filename.includes('..')) {
    throw ApiError.badRequest('Invalid filename');
  }
  const profile = await HirerProfile.findOne({ user: id });
  if (!profile) throw ApiError.notFound('Hirer profile not found');

  const before = profile.officePhotos.length;
  profile.officePhotos = profile.officePhotos.filter((u) => filenameFromUrl(u) !== filename);
  if (before === profile.officePhotos.length) throw ApiError.notFound('Photo not in profile');
  await profile.save();
  await removeFileQuiet(OFFICE_PHOTO_DIR, filename);

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
