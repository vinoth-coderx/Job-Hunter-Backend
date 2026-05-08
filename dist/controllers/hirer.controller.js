"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHirerStats = exports.getPublicCompanyProfile = exports.deleteOfficePhoto = exports.getOfficePhoto = exports.uploadOfficePhotos = exports.getHirerLogo = exports.uploadHirerLogo = exports.updateHirerProfile = exports.createHirerProfile = exports.getMyHirerProfile = exports.updateHirerProfileSchema = exports.createHirerProfileSchema = void 0;
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const zod_1 = require("zod");
const HirerProfile_1 = require("../models/HirerProfile");
const Job_1 = require("../models/Job");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const upload_1 = require("../middleware/upload");
const removeFileQuiet = async (dir, filename) => {
    if (!filename)
        return;
    try {
        await promises_1.default.unlink(path_1.default.join(dir, filename));
    }
    catch {
    }
};
const filenameFromUrl = (url) => {
    if (!url)
        return undefined;
    const last = url.split('/').filter(Boolean).pop();
    return last || undefined;
};
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
    if (!req.file)
        throw ApiError_1.ApiError.badRequest('No file uploaded — field name must be "logo"');
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: id });
    if (!profile) {
        await removeFileQuiet(upload_1.COMPANY_LOGO_DIR, req.file.filename);
        throw ApiError_1.ApiError.notFound('Hirer profile not found — create it first');
    }
    const old = filenameFromUrl(profile.companyLogoUrl);
    profile.companyLogoUrl = `/api/v1/hirer/profile/logo/${profile._id.toString()}/${req.file.filename}`;
    await profile.save();
    if (old && old !== req.file.filename)
        await removeFileQuiet(upload_1.COMPANY_LOGO_DIR, old);
    res.status(201).json({ success: true, data: { logoUrl: profile.companyLogoUrl } });
});
exports.getHirerLogo = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const filename = String(req.params.filename || '');
    if (!filename || filename.includes('/') || filename.includes('..')) {
        throw ApiError_1.ApiError.badRequest('Invalid filename');
    }
    const filePath = path_1.default.join(upload_1.COMPANY_LOGO_DIR, filename);
    try {
        await promises_1.default.access(filePath);
    }
    catch {
        throw ApiError_1.ApiError.notFound('Logo not found');
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
});
exports.uploadOfficePhotos = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = requireUser(req);
    const files = req.files ?? [];
    if (files.length === 0) {
        throw ApiError_1.ApiError.badRequest('No files uploaded — field name must be "photos"');
    }
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: id });
    if (!profile) {
        await Promise.all(files.map((f) => removeFileQuiet(upload_1.OFFICE_PHOTO_DIR, f.filename)));
        throw ApiError_1.ApiError.notFound('Hirer profile not found — create it first');
    }
    const newUrls = files.map((f) => `/api/v1/hirer/profile/photo/${profile._id.toString()}/${f.filename}`);
    const merged = [...profile.officePhotos, ...newUrls].slice(-10);
    const removed = [...profile.officePhotos, ...newUrls].slice(0, -10);
    profile.officePhotos = merged;
    await profile.save();
    await Promise.all(removed.map((u) => removeFileQuiet(upload_1.OFFICE_PHOTO_DIR, filenameFromUrl(u))));
    res.status(201).json({ success: true, data: { officePhotos: profile.officePhotos } });
});
exports.getOfficePhoto = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const filename = String(req.params.filename || '');
    if (!filename || filename.includes('/') || filename.includes('..')) {
        throw ApiError_1.ApiError.badRequest('Invalid filename');
    }
    const filePath = path_1.default.join(upload_1.OFFICE_PHOTO_DIR, filename);
    try {
        await promises_1.default.access(filePath);
    }
    catch {
        throw ApiError_1.ApiError.notFound('Photo not found');
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
});
exports.deleteOfficePhoto = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = requireUser(req);
    const filename = String(req.params.filename || '');
    if (!filename || filename.includes('/') || filename.includes('..')) {
        throw ApiError_1.ApiError.badRequest('Invalid filename');
    }
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: id });
    if (!profile)
        throw ApiError_1.ApiError.notFound('Hirer profile not found');
    const before = profile.officePhotos.length;
    profile.officePhotos = profile.officePhotos.filter((u) => filenameFromUrl(u) !== filename);
    if (before === profile.officePhotos.length)
        throw ApiError_1.ApiError.notFound('Photo not in profile');
    await profile.save();
    await removeFileQuiet(upload_1.OFFICE_PHOTO_DIR, filename);
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
