"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStreak = exports.checkInStreak = exports.listBadges = void 0;
const User_1 = require("../models/User");
const AppliedJob_1 = require("../models/AppliedJob");
const SavedJob_1 = require("../models/SavedJob");
const SkillAssessment_1 = require("../models/SkillAssessment");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const BADGES = [
    {
        id: 'first_app',
        title: 'First application',
        description: 'You sent your first application',
        category: 'apply',
        evaluate: (c) => c.appliedCount >= 1,
    },
    {
        id: 'power_applicant_10',
        title: 'Power applicant',
        description: 'Applied to 10+ jobs',
        category: 'apply',
        evaluate: (c) => c.appliedCount >= 10,
    },
    {
        id: 'hunter_50',
        title: 'Hunter',
        description: 'Applied to 50+ jobs',
        category: 'apply',
        evaluate: (c) => c.appliedCount >= 50,
    },
    {
        id: 'profile_starter',
        title: 'Profile starter',
        description: 'Profile is at least 50% complete',
        category: 'profile',
        evaluate: (c) => c.completion >= 50,
    },
    {
        id: 'profile_pro',
        title: 'Profile pro',
        description: 'Profile is 90%+ complete',
        category: 'profile',
        evaluate: (c) => c.completion >= 90,
    },
    {
        id: 'skill_stacker_5',
        title: 'Skill stacker',
        description: 'Listed 5+ skills',
        category: 'profile',
        evaluate: (c) => c.skillCount >= 5,
    },
    {
        id: 'bookmarked',
        title: 'Bookmarked',
        description: 'Saved your first job',
        category: 'engagement',
        evaluate: (c) => c.savedCount >= 1,
    },
    {
        id: 'streak_3',
        title: 'On a roll (3-day streak)',
        description: 'Checked in 3 days in a row',
        category: 'engagement',
        evaluate: (c) => c.streakCount >= 3,
    },
    {
        id: 'streak_7',
        title: 'Weekly warrior (7-day streak)',
        description: 'Checked in 7 days in a row',
        category: 'engagement',
        evaluate: (c) => c.streakCount >= 7,
    },
    {
        id: 'first_assessment',
        title: 'Verified skill',
        description: 'Passed your first skill assessment',
        category: 'mastery',
        evaluate: (c) => c.passedAssessments >= 1,
    },
];
const completenessFromUser = (user) => {
    const p = user.profile;
    let s = 0;
    if (p.fullName)
        s += 5;
    if (p.headline && p.headline.length >= 10)
        s += 10;
    if (p.experienceYears > 0)
        s += 5;
    if (p.skills?.length >= 5)
        s += 20;
    else if (p.skills?.length >= 1)
        s += 10;
    if (p.preferredRoles?.length > 0)
        s += 10;
    if (p.preferredLocations?.length > 0)
        s += 10;
    if (p.preferredJobTypes?.length > 0)
        s += 5;
    if (p.expectedSalaryMin && p.expectedSalaryMin > 0)
        s += 5;
    if (p.resumeUrl || p.resumeFile)
        s += 20;
    if (p.resumeText && p.resumeText.length > 200)
        s += 10;
    return Math.max(0, Math.min(100, s));
};
const buildContext = async (userId) => {
    const user = await User_1.User.findById(userId).lean();
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const [appliedCount, savedCount, passedAssessments] = await Promise.all([
        AppliedJob_1.AppliedJob.countDocuments({ user: userId }),
        SavedJob_1.SavedJob.countDocuments({ user: userId }),
        SkillAssessment_1.SkillAssessment.countDocuments({ user: userId, isPassed: true }),
    ]);
    return {
        appliedCount,
        savedCount,
        skillCount: user.profile?.skills?.length ?? 0,
        completion: completenessFromUser(user),
        streakCount: user.gamification?.streakCount ?? 0,
        passedAssessments,
    };
};
exports.listBadges = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const ctx = await buildContext(req.user.id);
    const badges = BADGES.map((b) => ({
        id: b.id,
        title: b.title,
        description: b.description,
        category: b.category,
        unlocked: b.evaluate(ctx),
    }));
    try {
        const user = await User_1.User.findById(req.user._id).select('gamification.earnedBadges');
        if (user) {
            const haveSet = new Set(user.gamification.earnedBadges.map((b) => b.badgeId));
            const newlyEarned = badges.filter((b) => b.unlocked && !haveSet.has(b.id));
            if (newlyEarned.length > 0) {
                user.gamification.earnedBadges.push(...newlyEarned.map((b) => ({ badgeId: b.id, earnedAt: new Date() })));
                await user.save();
            }
        }
    }
    catch {
    }
    res.json({
        success: true,
        data: {
            total: badges.length,
            unlocked: badges.filter((b) => b.unlocked).length,
            badges,
            stats: ctx,
        },
    });
});
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
const isYesterday = (last, today) => {
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    return sameDay(last, y);
};
exports.checkInStreak = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const today = new Date();
    const last = user.gamification.lastCheckinDate;
    let streakChanged = false;
    if (!last) {
        user.gamification.streakCount = 1;
        streakChanged = true;
    }
    else if (sameDay(last, today)) {
    }
    else if (isYesterday(last, today)) {
        user.gamification.streakCount += 1;
        streakChanged = true;
    }
    else {
        user.gamification.streakCount = 1;
        streakChanged = true;
    }
    if (user.gamification.streakCount > user.gamification.longestStreak) {
        user.gamification.longestStreak = user.gamification.streakCount;
    }
    user.gamification.lastCheckinDate = today;
    await user.save();
    res.json({
        success: true,
        data: {
            streakCount: user.gamification.streakCount,
            longestStreak: user.gamification.longestStreak,
            lastCheckinDate: user.gamification.lastCheckinDate,
            streakChanged,
        },
    });
});
exports.getStreak = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id)
        .select('gamification')
        .lean();
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    const today = new Date();
    const last = user.gamification?.lastCheckinDate
        ? new Date(user.gamification.lastCheckinDate)
        : undefined;
    let liveStreak = user.gamification?.streakCount ?? 0;
    if (last && !sameDay(last, today) && !isYesterday(last, today)) {
        liveStreak = 0;
    }
    res.json({
        success: true,
        data: {
            streakCount: liveStreak,
            longestStreak: user.gamification?.longestStreak ?? 0,
            lastCheckinDate: user.gamification?.lastCheckinDate ?? null,
            checkedInToday: last ? sameDay(last, today) : false,
        },
    });
});
