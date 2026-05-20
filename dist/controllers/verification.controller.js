"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.myVerificationStatus = exports.submitLinkedin = exports.submitLinkedinSchema = exports.submitWebsite = exports.submitWebsiteSchema = exports.confirmDomainEmail = exports.confirmDomainEmailSchema = exports.submitDomainEmail = exports.submitDomainEmailSchema = exports.submitGst = exports.submitGstSchema = void 0;
const zod_1 = require("zod");
const mongoose_1 = __importDefault(require("mongoose"));
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const Verification_1 = require("../models/Verification");
const HirerProfile_1 = require("../models/HirerProfile");
const otp_service_1 = require("../services/security/otp.service");
const audit_service_1 = require("../services/security/audit.service");
const trustScore_service_1 = require("../services/security/trustScore.service");
const requireHirer = async (req) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: req.user._id });
    if (!profile)
        throw new ApiError_1.ApiError(404, 'Hirer profile not found');
    return profile;
};
exports.submitGstSchema = zod_1.z.object({
    body: zod_1.z.object({
        gstNumber: zod_1.z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Invalid GST number'),
    }),
});
exports.submitGst = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const profile = await requireHirer(req);
    const v = await Verification_1.Verification.create({
        hirer: req.user.id,
        company: profile._id,
        channel: 'gst',
        payload: { gstNumber: req.body.gstNumber },
    });
    profile.verification.gstNumber = req.body.gstNumber;
    await profile.save();
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user.id, email: req.user.email },
        actorType: 'hirer',
        category: 'verification',
        action: 'verification:gst:submitted',
        target: { type: 'Verification', id: v._id },
        req,
    });
    res.status(201).json({ success: true, data: v });
});
exports.submitDomainEmailSchema = zod_1.z.object({
    body: zod_1.z.object({
        email: zod_1.z.string().email().max(200),
    }),
});
exports.submitDomainEmail = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const profile = await requireHirer(req);
    const email = req.body.email.toLowerCase();
    if (profile.website) {
        const domain = profile.website.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
        if (!email.endsWith('@' + domain)) {
            throw new ApiError_1.ApiError(400, `Email must match your company website domain (${domain})`);
        }
    }
    await Verification_1.Verification.create({
        hirer: req.user.id,
        company: profile._id,
        channel: 'domain_email',
        payload: { domainEmail: email },
    });
    await (0, otp_service_1.issueOtp)({
        identifier: email,
        channel: 'email',
        purpose: 'sensitive_action',
        userId: req.user.id,
        ip: req.ip,
    });
    res.json({ success: true, message: 'OTP sent to your company email' });
});
exports.confirmDomainEmailSchema = zod_1.z.object({
    body: zod_1.z.object({
        email: zod_1.z.string().email(),
        code: zod_1.z.string().length(6),
    }),
});
exports.confirmDomainEmail = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const profile = await requireHirer(req);
    await (0, otp_service_1.verifyOtp)({ identifier: req.body.email, code: req.body.code, purpose: 'sensitive_action' });
    await Verification_1.Verification.updateMany({ hirer: req.user.id, company: profile._id, channel: 'domain_email', status: 'pending' }, {
        $set: {
            status: 'auto_verified',
            'payload.domainEmailVerifiedAt': new Date(),
            reviewedAt: new Date(),
        },
    });
    profile.verification.levels.domainEmail = true;
    profile.verification.officialDomainEmail = req.body.email.toLowerCase();
    profile.verification.isVerified = Object.values(profile.verification.levels).some(Boolean);
    await profile.save();
    await (0, trustScore_service_1.recomputeHirerTrust)(req.user.id);
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user.id, email: req.user.email },
        actorType: 'hirer',
        category: 'verification',
        action: 'verification:domain_email:approved',
        req,
    });
    res.json({ success: true });
});
exports.submitWebsiteSchema = zod_1.z.object({
    body: zod_1.z.object({ website: zod_1.z.string().url().max(500) }),
});
exports.submitWebsite = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const profile = await requireHirer(req);
    const token = `jobhunter-verify-${new mongoose_1.default.Types.ObjectId().toHexString()}`;
    await Verification_1.Verification.create({
        hirer: req.user.id,
        company: profile._id,
        channel: 'website',
        payload: { website: req.body.website, websiteFileToken: token },
    });
    res.status(201).json({
        success: true,
        data: {
            website: req.body.website,
            token,
            instructions: `Host a file at ${req.body.website.replace(/\/$/, '')}/.well-known/jobhunter-verification.txt whose body is the token above, then call POST /api/v1/hirer/verification/website/confirm.`,
        },
    });
});
exports.submitLinkedinSchema = zod_1.z.object({
    body: zod_1.z.object({ linkedinUrl: zod_1.z.string().url().max(500) }),
});
exports.submitLinkedin = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const profile = await requireHirer(req);
    const v = await Verification_1.Verification.create({
        hirer: req.user.id,
        company: profile._id,
        channel: 'linkedin',
        payload: { linkedinUrl: req.body.linkedinUrl },
    });
    profile.verification.linkedinPageUrl = req.body.linkedinUrl;
    await profile.save();
    res.status(201).json({ success: true, data: v });
});
exports.myVerificationStatus = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const profile = await requireHirer(req);
    const submissions = await Verification_1.Verification.find({ hirer: req.user.id })
        .sort({ createdAt: -1 })
        .lean();
    res.json({
        success: true,
        data: {
            profile: {
                isVerified: profile.verification.isVerified,
                levels: profile.verification.levels,
                approvalStatus: profile.approvalStatus,
                trustScore: profile.trustScore,
            },
            submissions,
        },
    });
});
