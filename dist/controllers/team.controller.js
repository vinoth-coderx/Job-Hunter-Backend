"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.revokeInvite = exports.updateMemberRole = exports.removeMember = exports.acceptInvite = exports.listTeam = exports.inviteTeamMember = exports.updateRoleSchema = exports.acceptSchema = exports.inviteSchema = void 0;
const zod_1 = require("zod");
const crypto_1 = __importDefault(require("crypto"));
const mongoose_1 = __importDefault(require("mongoose"));
const HirerProfile_1 = require("../models/HirerProfile");
const TeamInvite_1 = require("../models/TeamInvite");
const User_1 = require("../models/User");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const email_service_1 = require("../services/notification/email.service");
const logger_1 = require("../utils/logger");
const isObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
exports.inviteSchema = zod_1.z.object({
    body: zod_1.z.object({
        email: zod_1.z.string().email().max(200),
        role: zod_1.z.enum(['admin', 'recruiter', 'interviewer']),
    }),
});
exports.acceptSchema = zod_1.z.object({
    body: zod_1.z.object({
        token: zod_1.z.string().min(32).max(128),
    }),
});
exports.updateRoleSchema = zod_1.z.object({
    body: zod_1.z.object({
        role: zod_1.z.enum(['admin', 'recruiter', 'interviewer']),
    }),
});
const requireOwnedHirerProfile = async (userId) => {
    const profile = await HirerProfile_1.HirerProfile.findOne({ user: userId });
    if (!profile)
        throw ApiError_1.ApiError.forbidden('Set up a company profile first');
    return profile;
};
const requireAdminOnHirer = async (userId) => {
    const profile = await HirerProfile_1.HirerProfile.findOne({
        $or: [
            { user: userId },
            {
                teamMembers: {
                    $elemMatch: {
                        user: new mongoose_1.default.Types.ObjectId(userId),
                        role: 'admin',
                        isActive: true,
                    },
                },
            },
        ],
    });
    if (!profile)
        throw ApiError_1.ApiError.forbidden('Admin access required');
    return profile;
};
exports.inviteTeamMember = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireAdminOnHirer(req.user.id);
    const { email, role } = req.body;
    const existingUser = await User_1.User.findOne({ email: email.toLowerCase() }).select('_id').lean();
    if (existingUser) {
        const already = profile.teamMembers.some((m) => m.user.toString() === existingUser._id.toString() && m.isActive);
        if (already)
            throw ApiError_1.ApiError.conflict('Already a team member');
    }
    const token = crypto_1.default.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const invite = await TeamInvite_1.TeamInvite.findOneAndUpdate({
        hirerProfile: profile._id,
        email: email.toLowerCase(),
        status: 'pending',
    }, {
        $set: {
            hirerProfile: profile._id,
            invitedBy: req.user._id,
            email: email.toLowerCase(),
            role,
            token,
            status: 'pending',
            expiresAt,
        },
    }, { upsert: true, new: true });
    const inviter = await User_1.User.findById(req.user._id)
        .select('email profile.fullName')
        .lean();
    void (0, email_service_1.sendTeamInviteEmail)({
        toEmail: invite.email,
        companyName: profile.companyName,
        inviterName: inviter?.profile?.fullName || inviter?.email,
        role: invite.role,
        token: invite.token,
        expiresAt: invite.expiresAt,
    }).catch((err) => logger_1.logger.warn(`team invite email dispatch failed: ${err.message}`));
    res.status(201).json({
        success: true,
        data: {
            id: invite._id.toString(),
            email: invite.email,
            role: invite.role,
            token: invite.token,
            expiresAt: invite.expiresAt,
        },
    });
});
exports.listTeam = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireOwnedHirerProfile(req.user.id);
    const populated = await HirerProfile_1.HirerProfile.findById(profile._id)
        .populate({
        path: 'teamMembers.user',
        select: 'email profile.fullName profile.avatar',
    })
        .lean();
    const members = (populated?.teamMembers ?? [])
        .filter((m) => m.isActive)
        .map((m) => {
        const u = m.user;
        return {
            userId: u?._id.toString() ?? null,
            email: u?.email ?? null,
            fullName: u?.profile?.fullName ?? null,
            avatar: u?.profile?.avatar ?? null,
            role: m.role,
            addedAt: m.addedAt,
        };
    });
    const invites = await TeamInvite_1.TeamInvite.find({
        hirerProfile: profile._id,
        status: 'pending',
    })
        .sort({ createdAt: -1 })
        .select('email role expiresAt createdAt')
        .lean();
    res.json({
        success: true,
        data: {
            ownerUserId: profile.user.toString(),
            members,
            pendingInvites: invites.map((i) => ({
                email: i.email,
                role: i.role,
                expiresAt: i.expiresAt,
                invitedAt: i.createdAt,
            })),
        },
    });
});
exports.acceptInvite = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { token } = req.body;
    const invite = await TeamInvite_1.TeamInvite.findOne({ token, status: 'pending' });
    if (!invite)
        throw ApiError_1.ApiError.notFound('Invalid or expired invite');
    if (invite.expiresAt < new Date()) {
        invite.status = 'expired';
        await invite.save();
        throw ApiError_1.ApiError.badRequest('Invite has expired');
    }
    const user = await User_1.User.findById(req.user._id).select('email').lean();
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw ApiError_1.ApiError.forbidden('This invite was sent to a different email');
    }
    const profile = await HirerProfile_1.HirerProfile.findById(invite.hirerProfile);
    if (!profile)
        throw ApiError_1.ApiError.notFound('Company no longer exists');
    const existing = profile.teamMembers.find((m) => m.user.toString() === req.user._id.toString());
    if (existing) {
        existing.role = invite.role;
        existing.isActive = true;
    }
    else {
        profile.teamMembers.push({
            user: req.user._id,
            role: invite.role,
            addedAt: new Date(),
            isActive: true,
        });
    }
    await profile.save();
    invite.status = 'accepted';
    invite.acceptedAt = new Date();
    invite.acceptedBy = req.user._id;
    await invite.save();
    res.json({
        success: true,
        data: {
            hirerProfileId: profile._id.toString(),
            companyName: profile.companyName,
            role: invite.role,
        },
    });
});
exports.removeMember = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireAdminOnHirer(req.user.id);
    const userId = String(req.params.userId);
    if (!isObjectId(userId))
        throw ApiError_1.ApiError.badRequest('Invalid user id');
    if (userId === profile.user.toString()) {
        throw ApiError_1.ApiError.forbidden('The owner cannot be removed from the team');
    }
    const before = profile.teamMembers.length;
    profile.teamMembers = profile.teamMembers.filter((m) => m.user.toString() !== userId);
    if (profile.teamMembers.length === before) {
        throw ApiError_1.ApiError.notFound('Member not found');
    }
    await profile.save();
    res.json({ success: true, message: 'Removed' });
});
exports.updateMemberRole = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireAdminOnHirer(req.user.id);
    const userId = String(req.params.userId);
    if (!isObjectId(userId))
        throw ApiError_1.ApiError.badRequest('Invalid user id');
    const { role } = req.body;
    if (userId === profile.user.toString()) {
        throw ApiError_1.ApiError.forbidden('The owner\'s role is fixed');
    }
    const member = profile.teamMembers.find((m) => m.user.toString() === userId);
    if (!member)
        throw ApiError_1.ApiError.notFound('Member not found');
    member.role = role;
    await profile.save();
    res.json({ success: true, data: { userId, role } });
});
exports.revokeInvite = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const profile = await requireAdminOnHirer(req.user.id);
    const id = String(req.params.id);
    if (!isObjectId(id))
        throw ApiError_1.ApiError.badRequest('Invalid invite id');
    const invite = await TeamInvite_1.TeamInvite.findOneAndUpdate({ _id: id, hirerProfile: profile._id, status: 'pending' }, { $set: { status: 'revoked' } }, { new: true });
    if (!invite)
        throw ApiError_1.ApiError.notFound('Pending invite not found');
    res.json({ success: true });
});
