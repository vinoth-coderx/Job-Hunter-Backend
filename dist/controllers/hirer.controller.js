"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCompanyDescriptionEndpoint = exports.generateCompanyDescriptionSchema = exports.getHirerStats = exports.getPublicCompanyProfile = exports.deleteOfficePhoto = exports.uploadOfficePhotos = exports.uploadHirerLogo = exports.updateHirerProfile = exports.createHirerProfile = exports.getMyHirerProfile = exports.updateHirerProfileSchema = exports.createHirerProfileSchema = void 0;
const zod_1 = require("zod");
const HirerProfile_1 = require("../models/HirerProfile");
const Job_1 = require("../models/Job");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const cloudinary_1 = require("../config/cloudinary");
const companyDescription_service_1 = require("../services/ai/companyDescription.service");
const quota_service_1 = require("../services/ai/quota.service");
const aiCreditWeights_1 = require("../config/aiCreditWeights");
const otherLocationSchema = zod_1.z.object({
    city: zod_1.z.string().min(1).max(100),
    state: zod_1.z.string().max(100).optional(),
});
const headquartersSchema = zod_1.z.object({
    city: zod_1.z.string().max(100).optional(),
    state: zod_1.z.string().max(100).optional(),
    country: zod_1.z.string().max(100).optional(),
    address: zod_1.z.string().max(500).optional(),
});
const socialLinksSchema = zod_1.z.object({
    linkedin: zod_1.z.string().url().max(500).optional().or(zod_1.z.literal('').transform(() => undefined)),
    twitter: zod_1.z.string().url().max(500).optional().or(zod_1.z.literal('').transform(() => undefined)),
    glassdoor: zod_1.z.string().url().max(500).optional().or(zod_1.z.literal('').transform(() => undefined)),
});
exports.createHirerProfileSchema = zod_1.z.object({
    body: zod_1.z.object({
        companyName: zod_1.z.string().min(2).max(200),
        industry: zod_1.z.string().max(100).optional(),
        companySize: zod_1.z
            .enum(['1-10', '11-50', '51-200', '201-500', '500-1000', '1000+'])
            .optional(),
        foundedYear: zod_1.z.coerce.number().int().min(1800).max(new Date().getFullYear()).optional(),
        website: zod_1.z.string().url().max(500).optional().or(zod_1.z.literal('').transform(() => undefined)),
        description: zod_1.z.string().max(5000).optional(),
        cultureValues: zod_1.z.string().max(5000).optional(),
        headquarters: headquartersSchema.optional(),
        otherLocations: zod_1.z.array(otherLocationSchema).max(20).optional(),
        socialLinks: socialLinksSchema.optional(),
    }),
});
exports.updateHirerProfileSchema = exports.createHirerProfileSchema.deepPartial();
const requireUser = (req) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    return { id: req.user.id };
};
const sanitiseProfile = (p) => ({
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
    approvalStatus: p.approvalStatus,
    trustScore: p.trustScore,
    dailyPostLimit: p.dailyPostLimit,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
});
exports.getMyHirerProfile = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = requireUser(req);
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: id });
    if (!profile) {
        res.json({ success: true, data: null });
        return;
    }
    res.json({ success: true, data: sanitiseProfile(profile) });
});
exports.createHirerProfile = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = requireUser(req);
    const existing = await HirerProfile_1.HirerProfile.findOne({ user: id });
    if (existing)
        throw ApiError_1.ApiError.conflict('Hirer profile already exists; use PUT to update');
    const body = req.body;
    const profile = await HirerProfile_1.HirerProfile.create({
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
exports.updateHirerProfile = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = requireUser(req);
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: id });
    if (!profile)
        throw ApiError_1.ApiError.notFound('Hirer profile not found');
    const body = req.body;
    const updatable = [
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
        if (body[key] !== undefined) {
            profile[key] = body[key];
        }
    }
    await profile.save();
    res.json({ success: true, data: sanitiseProfile(profile) });
});
exports.uploadHirerLogo = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = requireUser(req);
    if (!req.file || !req.file.buffer) {
        throw ApiError_1.ApiError.badRequest('No file uploaded — field name must be "logo"');
    }
    if (!(0, cloudinary_1.isCloudinaryConfigured)()) {
        throw ApiError_1.ApiError.internal('Cloudinary is not configured on the server');
    }
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: id });
    if (!profile)
        throw ApiError_1.ApiError.notFound('Hirer profile not found — create it first');
    const oldPublicId = profile.companyLogoPublicId;
    const result = await (0, cloudinary_1.uploadBuffer)(req.file.buffer, {
        folder: cloudinary_1.CLOUDINARY_FOLDERS.COMPANY_LOGO,
        publicId: `hirer_${profile._id.toString()}`,
        resourceType: 'image',
        overwrite: true,
        tags: ['company-logo', `hirer:${profile._id.toString()}`],
    });
    profile.companyLogoUrl = result.url;
    profile.companyLogoPublicId = result.publicId;
    await profile.save();
    if (oldPublicId && oldPublicId !== result.publicId) {
        await (0, cloudinary_1.destroyAsset)(oldPublicId, 'image');
    }
    res.status(201).json({ success: true, data: { logoUrl: profile.companyLogoUrl } });
});
exports.uploadOfficePhotos = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = requireUser(req);
    const files = req.files ?? [];
    if (files.length === 0) {
        throw ApiError_1.ApiError.badRequest('No files uploaded — field name must be "photos"');
    }
    if (!(0, cloudinary_1.isCloudinaryConfigured)()) {
        throw ApiError_1.ApiError.internal('Cloudinary is not configured on the server');
    }
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: id });
    if (!profile)
        throw ApiError_1.ApiError.notFound('Hirer profile not found — create it first');
    const tag = `hirer:${profile._id.toString()}`;
    const uploads = await Promise.all(files.map((f) => (0, cloudinary_1.uploadBuffer)(f.buffer, {
        folder: cloudinary_1.CLOUDINARY_FOLDERS.OFFICE_PHOTO,
        resourceType: 'image',
        tags: ['office-photo', tag],
    })));
    const newUrls = uploads.map((u) => u.url);
    const combined = [...profile.officePhotos, ...newUrls];
    const merged = combined.slice(-10);
    const removed = combined.slice(0, combined.length - merged.length);
    profile.officePhotos = merged;
    await profile.save();
    await Promise.all(removed
        .map((u) => (0, cloudinary_1.publicIdFromUrl)(u))
        .filter((p) => !!p)
        .map((p) => (0, cloudinary_1.destroyAsset)(p, 'image')));
    res.status(201).json({ success: true, data: { officePhotos: profile.officePhotos } });
});
exports.deleteOfficePhoto = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = requireUser(req);
    const raw = String(req.params.filename || '').trim();
    if (!raw)
        throw ApiError_1.ApiError.badRequest('Missing public_id');
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: id });
    if (!profile)
        throw ApiError_1.ApiError.notFound('Hirer profile not found');
    const targetPid = raw.startsWith('http') ? (0, cloudinary_1.publicIdFromUrl)(raw) : raw;
    if (!targetPid)
        throw ApiError_1.ApiError.badRequest('Could not resolve public_id');
    const before = profile.officePhotos.length;
    profile.officePhotos = profile.officePhotos.filter((u) => (0, cloudinary_1.publicIdFromUrl)(u) !== targetPid);
    if (before === profile.officePhotos.length)
        throw ApiError_1.ApiError.notFound('Photo not in profile');
    await profile.save();
    await (0, cloudinary_1.destroyAsset)(targetPid, 'image');
    res.json({ success: true, data: { officePhotos: profile.officePhotos } });
});
exports.getPublicCompanyProfile = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = String(req.params.id || '');
    const profile = await HirerProfile_1.HirerProfile.findById(id);
    if (!profile)
        throw ApiError_1.ApiError.notFound('Company not found');
    const activeJobsCount = await Job_1.Job.countDocuments({
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
exports.getHirerStats = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = requireUser(req);
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: id });
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
        Job_1.Job.countDocuments({ hirerProfile: profile._id, status: 'active', isNative: true }),
        Job_1.Job.countDocuments({ hirerProfile: profile._id, status: 'draft', isNative: true }),
        Job_1.Job.countDocuments({ hirerProfile: profile._id, status: 'closed', isNative: true }),
        Job_1.Job.aggregate([
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
exports.generateCompanyDescriptionSchema = zod_1.z.object({
    body: zod_1.z.object({
        companyName: zod_1.z.string().min(2).max(200).optional(),
        industry: zod_1.z.string().max(120).optional(),
        sizeBand: zod_1.z.string().max(60).optional(),
        hqLocation: zod_1.z.string().max(120).optional(),
        whatYouDo: zod_1.z.string().max(2000).optional(),
        toneHint: zod_1.z.enum(['professional', 'casual', 'startup']).optional(),
    }),
});
exports.generateCompanyDescriptionEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const userId = String(req.user._id);
    const body = req.body;
    let companyName = (body.companyName || '').trim();
    if (!companyName) {
        const profile = await HirerProfile_1.HirerProfile.findOne({ user: userId })
            .select('companyName')
            .lean();
        companyName = profile?.companyName?.trim() || '';
    }
    if (companyName.length < 2) {
        throw ApiError_1.ApiError.badRequest('Company name is required to generate a description');
    }
    const weight = (0, aiCreditWeights_1.getCreditWeight)('company_description');
    const quota = await (0, quota_service_1.enforceQuota)(userId, weight);
    let result;
    try {
        result = await (0, companyDescription_service_1.generateCompanyDescription)({
            companyName,
            industry: body.industry,
            sizeBand: body.sizeBand,
            hqLocation: body.hqLocation,
            whatYouDo: body.whatYouDo,
            toneHint: body.toneHint,
        }, { userId });
    }
    catch (err) {
        await (0, quota_service_1.refundQuota)(userId, weight);
        throw err;
    }
    if (!result.usedAi) {
        await (0, quota_service_1.refundQuota)(userId, weight);
    }
    res.json({
        success: true,
        data: result,
        quota,
    });
});
