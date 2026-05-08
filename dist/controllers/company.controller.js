"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listReviews = exports.submitReview = exports.listFollowedCompanies = exports.unfollowCompany = exports.followCompany = exports.listCompanyJobs = exports.getCompanyProfile = exports.reviewSchema = void 0;
const zod_1 = require("zod");
const mongoose_1 = __importDefault(require("mongoose"));
const HirerProfile_1 = require("../models/HirerProfile");
const CompanyFollow_1 = require("../models/CompanyFollow");
const CompanyReview_1 = require("../models/CompanyReview");
const Job_1 = require("../models/Job");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
const ratingsSchema = zod_1.z.object({
    overall: zod_1.z.number().min(1).max(5),
    culture: zod_1.z.number().min(1).max(5).optional(),
    workLifeBalance: zod_1.z.number().min(1).max(5).optional(),
    growth: zod_1.z.number().min(1).max(5).optional(),
    pay: zod_1.z.number().min(1).max(5).optional(),
    management: zod_1.z.number().min(1).max(5).optional(),
});
exports.reviewSchema = zod_1.z.object({
    body: zod_1.z.object({
        isAnonymous: zod_1.z.boolean().default(true),
        reviewerRole: zod_1.z.enum(['candidate', 'employee', 'ex_employee']),
        ratings: ratingsSchema,
        title: zod_1.z.string().max(200).optional(),
        pros: zod_1.z.string().max(4000).optional(),
        cons: zod_1.z.string().max(4000).optional(),
        adviceToManagement: zod_1.z.string().max(4000).optional(),
        interviewExperience: zod_1.z
            .object({
            difficulty: zod_1.z.enum(['easy', 'medium', 'hard']).optional(),
            result: zod_1.z.enum(['got_offer', 'rejected', 'withdrew']).optional(),
            description: zod_1.z.string().max(4000).optional(),
        })
            .optional(),
    }),
});
exports.getCompanyProfile = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid company id');
    const profile = await HirerProfile_1.HirerProfile.findById(id).lean();
    if (!profile)
        throw ApiError_1.ApiError.notFound('Company not found');
    const [activeJobsCount, isFollowing] = await Promise.all([
        Job_1.Job.countDocuments({
            hirerProfile: profile._id,
            status: 'active',
            isActive: true,
            isNative: true,
        }),
        req.user
            ? CompanyFollow_1.CompanyFollow.findOne({
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
exports.listCompanyJobs = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid company id');
    const items = await Job_1.Job.find({
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
exports.followCompany = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid company id');
    const profile = await HirerProfile_1.HirerProfile.findById(id).select('_id').lean();
    if (!profile)
        throw ApiError_1.ApiError.notFound('Company not found');
    try {
        await CompanyFollow_1.CompanyFollow.create({
            user: req.user._id,
            hirerProfile: new mongoose_1.default.Types.ObjectId(id),
        });
        await HirerProfile_1.HirerProfile.updateOne({ _id: id }, { $inc: { followersCount: 1 } });
        res.status(201).json({ success: true, message: 'Following' });
    }
    catch (err) {
        if (typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            err.code === 11000) {
            res.json({ success: true, message: 'Already following' });
            return;
        }
        throw err;
    }
});
exports.unfollowCompany = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid company id');
    const result = await CompanyFollow_1.CompanyFollow.deleteOne({
        user: req.user._id,
        hirerProfile: new mongoose_1.default.Types.ObjectId(id),
    });
    if (result.deletedCount > 0) {
        await HirerProfile_1.HirerProfile.updateOne({ _id: id, followersCount: { $gt: 0 } }, { $inc: { followersCount: -1 } });
    }
    res.json({ success: true, message: 'Unfollowed' });
});
exports.listFollowedCompanies = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const items = await CompanyFollow_1.CompanyFollow.find({ user: req.user._id })
        .sort({ followedAt: -1 })
        .populate({
        path: 'hirerProfile',
        select: 'companyName companyLogoUrl industry rating followersCount verification',
    })
        .lean();
    const list = items
        .map((i) => i.hirerProfile)
        .filter((c) => c !== null);
    res.json({ success: true, data: list });
});
const recomputeRating = async (hirerProfileId) => {
    const docs = await CompanyReview_1.CompanyReview.find({
        hirerProfile: hirerProfileId,
        isApproved: true,
    })
        .select('ratings.overall')
        .lean();
    if (docs.length === 0) {
        await HirerProfile_1.HirerProfile.updateOne({ _id: hirerProfileId }, { $set: { 'rating.average': 0, 'rating.totalReviews': 0 } });
        return;
    }
    const sum = docs.reduce((s, r) => s + (r.ratings?.overall ?? 0), 0);
    const avg = Math.round((sum / docs.length) * 10) / 10;
    await HirerProfile_1.HirerProfile.updateOne({ _id: hirerProfileId }, {
        $set: {
            'rating.average': avg,
            'rating.totalReviews': docs.length,
        },
    });
};
exports.submitReview = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid company id');
    const profile = await HirerProfile_1.HirerProfile.findById(id).select('_id user').lean();
    if (!profile)
        throw ApiError_1.ApiError.notFound('Company not found');
    if (profile.user.toString() === req.user.id) {
        throw ApiError_1.ApiError.forbidden('You cannot review your own company');
    }
    const body = req.body;
    await CompanyReview_1.CompanyReview.findOneAndUpdate({ hirerProfile: profile._id, user: req.user._id }, {
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
    }, { upsert: true, new: true });
    await recomputeRating(profile._id);
    res.status(201).json({ success: true, message: 'Review submitted' });
});
exports.listReviews = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid company id');
    const reviews = await CompanyReview_1.CompanyReview.find({
        hirerProfile: new mongoose_1.default.Types.ObjectId(id),
        isApproved: true,
    })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate({ path: 'user', select: 'profile.fullName profile.avatar' })
        .lean();
    const sanitised = reviews.map((r) => ({
        id: r._id.toString(),
        isAnonymous: r.isAnonymous,
        reviewerRole: r.reviewerRole,
        reviewer: r.isAnonymous
            ? null
            : {
                fullName: r.user?.profile?.fullName ?? null,
                avatar: r.user?.profile?.avatar ?? null,
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
