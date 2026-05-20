"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkPasswordStrength = exports.checkPasswordStrengthSchema = exports.listResumeAccessLog = exports.updatePrivacy = exports.updatePrivacySchema = exports.revokeAllSessionsHandler = exports.revokeSessionHandler = exports.listSessions = exports.disable2faHandler = exports.verify2fa = exports.finish2faEnrollment = exports.verify2faSchema = exports.start2faEnrollment = exports.verifyOtpHandler = exports.verifyOtpSchema = exports.sendOtp = exports.sendOtpSchema = void 0;
const zod_1 = require("zod");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const User_1 = require("../models/User");
const otp_service_1 = require("../services/security/otp.service");
const totp_service_1 = require("../services/security/totp.service");
const session_service_1 = require("../services/security/session.service");
const ResumeAccessLog_1 = require("../models/ResumeAccessLog");
const audit_service_1 = require("../services/security/audit.service");
exports.sendOtpSchema = zod_1.z.object({
    body: zod_1.z.object({
        channel: zod_1.z.enum(['email', 'phone']),
        purpose: zod_1.z.enum(['email_verification', 'phone_verification', 'password_reset', 'sensitive_action']),
        identifier: zod_1.z.string().min(3).max(120),
    }),
});
exports.sendOtp = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    await (0, otp_service_1.issueOtp)({
        channel: req.body.channel,
        purpose: req.body.purpose,
        identifier: req.body.identifier,
        userId: req.user?.id,
        ip: req.ip,
    });
    res.json({ success: true, message: 'OTP sent' });
});
exports.verifyOtpSchema = zod_1.z.object({
    body: zod_1.z.object({
        identifier: zod_1.z.string().min(3).max(120),
        code: zod_1.z.string().length(6),
        purpose: zod_1.z.enum(['email_verification', 'phone_verification', 'password_reset', 'sensitive_action']),
    }),
});
exports.verifyOtpHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    await (0, otp_service_1.verifyOtp)({
        identifier: req.body.identifier,
        code: req.body.code,
        purpose: req.body.purpose,
    });
    if (req.user?._id) {
        if (req.body.purpose === 'email_verification') {
            await User_1.User.updateOne({ _id: req.user.id }, { $set: { isEmailVerified: true } });
        }
        else if (req.body.purpose === 'phone_verification') {
            await User_1.User.updateOne({ _id: req.user.id }, { $set: { isPhoneVerified: true, 'profile.phone': req.body.identifier } });
        }
    }
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user?._id, email: req.user?.email },
        actorType: 'user',
        category: 'auth',
        action: `otp:${req.body.purpose}:verified`,
        req,
    });
    res.json({ success: true });
});
exports.start2faEnrollment = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const out = await (0, totp_service_1.startEnrollment)(req.user.id);
    res.json({ success: true, data: out });
});
exports.verify2faSchema = zod_1.z.object({
    body: zod_1.z.object({ token: zod_1.z.string().min(6).max(12) }),
});
exports.finish2faEnrollment = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const out = await (0, totp_service_1.completeEnrollment)(req.user.id, req.body.token);
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user.id, email: req.user.email },
        actorType: 'user',
        category: 'auth',
        action: '2fa:enabled',
        req,
    });
    res.json({ success: true, data: out });
});
exports.verify2fa = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const ok = await (0, totp_service_1.verifyLoginToken)(req.user.id, req.body.token);
    if (!ok)
        throw new ApiError_1.ApiError(400, 'Incorrect code');
    res.json({ success: true });
});
exports.disable2faHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    await (0, totp_service_1.disable2fa)(req.user.id);
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user.id, email: req.user.email },
        actorType: 'user',
        category: 'auth',
        action: '2fa:disabled',
        req,
    });
    res.json({ success: true });
});
exports.listSessions = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const sessions = await (0, session_service_1.listActiveSessions)(req.user.id);
    res.json({ success: true, data: sessions });
});
exports.revokeSessionHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const sessionId = req.params.id;
    await (0, session_service_1.revokeSession)(req.user.id, sessionId);
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user.id, email: req.user.email },
        actorType: 'user',
        category: 'auth',
        action: 'session:revoked',
        target: { type: 'UserSession', id: sessionId },
        req,
    });
    res.json({ success: true });
});
exports.revokeAllSessionsHandler = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    await (0, session_service_1.revokeAllSessions)(req.user.id);
    res.json({ success: true });
});
exports.updatePrivacySchema = zod_1.z.object({
    body: zod_1.z.object({
        openToWork: zod_1.z.boolean().optional(),
        hideFromCurrentEmployer: zod_1.z.boolean().optional(),
        hidePersonalDetails: zod_1.z.boolean().optional(),
        hideContactUntilShortlisted: zod_1.z.boolean().optional(),
        resumeVisibility: zod_1.z.enum(['public', 'applied_only', 'private']).optional(),
        searchableInResumeDatabase: zod_1.z.boolean().optional(),
        allowResumeDownload: zod_1.z.boolean().optional(),
    }),
});
exports.updatePrivacy = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const updates = {};
    for (const [k, v] of Object.entries(req.body)) {
        if (v !== undefined)
            updates[`privacy.${k}`] = v;
    }
    const user = await User_1.User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true });
    res.json({ success: true, data: user?.privacy });
});
exports.listResumeAccessLog = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const logs = await ResumeAccessLog_1.ResumeAccessLog.find({ resumeOwner: req.user.id })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('accessor', 'profile.fullName email')
        .lean();
    res.json({ success: true, data: logs });
});
exports.checkPasswordStrengthSchema = zod_1.z.object({
    body: zod_1.z.object({ password: zod_1.z.string().min(1).max(200) }),
});
exports.checkPasswordStrength = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const pwd = req.body.password;
    let score = 0;
    if (pwd.length >= 12)
        score += 25;
    else if (pwd.length >= 8)
        score += 12;
    if (/[A-Z]/.test(pwd))
        score += 15;
    if (/[a-z]/.test(pwd))
        score += 10;
    if (/[0-9]/.test(pwd))
        score += 15;
    if (/[^A-Za-z0-9]/.test(pwd))
        score += 20;
    if (!/(.)\1{2,}/.test(pwd))
        score += 5;
    if (!/^(password|qwerty|admin|welcome|letmein)/i.test(pwd))
        score += 10;
    const band = score >= 80 ? 'strong' : score >= 55 ? 'good' : score >= 35 ? 'fair' : 'weak';
    res.json({ success: true, data: { score: Math.min(100, score), band } });
});
