"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trustBandLabel = exports.recomputeUserTrust = exports.recomputeHirerTrust = void 0;
const HirerProfile_1 = require("../../models/HirerProfile");
const Job_1 = require("../../models/Job");
const Report_1 = require("../../models/Report");
const JobModeration_1 = require("../../models/JobModeration");
const User_1 = require("../../models/User");
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const recomputeHirerTrust = async (hirerId) => {
    const hirer = await HirerProfile_1.HirerProfile.findOne({ user: hirerId });
    if (!hirer)
        return 0;
    let score = 50;
    if (hirer.verification.levels.gst)
        score += 12;
    if (hirer.verification.levels.domainEmail)
        score += 10;
    if (hirer.verification.levels.website)
        score += 6;
    if (hirer.verification.levels.linkedin)
        score += 6;
    if (hirer.verification.levels.identity)
        score += 8;
    const jobsPosted = await Job_1.Job.countDocuments({ postedBy: hirerId, isNative: true });
    score += Math.min(8, Math.floor(jobsPosted / 5));
    const flagged = await JobModeration_1.JobModeration.countDocuments({
        hirer: hirerId,
        decision: { $in: ['auto_rejected', 'queued'] },
    });
    score -= flagged * 3;
    const reportsAgainst = await Report_1.Report.countDocuments({
        subjectType: 'recruiter',
        subjectId: hirerId,
        status: { $ne: 'dismissed' },
    });
    score -= reportsAgainst * 6;
    if (hirer.approvalStatus === 'suspended')
        score -= 25;
    if (hirer.approvalStatus === 'banned')
        score = 0;
    hirer.trustScore = clamp(score);
    hirer.totalJobsPosted = jobsPosted;
    hirer.totalJobsFlagged = flagged;
    hirer.totalReportsAgainst = reportsAgainst;
    if (hirer.trustScore >= 80)
        hirer.dailyPostLimit = 50;
    else if (hirer.trustScore >= 60)
        hirer.dailyPostLimit = 15;
    else if (hirer.trustScore >= 40)
        hirer.dailyPostLimit = 5;
    else
        hirer.dailyPostLimit = 2;
    await hirer.save();
    return hirer.trustScore;
};
exports.recomputeHirerTrust = recomputeHirerTrust;
const recomputeUserTrust = async (userId) => {
    const user = await User_1.User.findById(userId);
    if (!user)
        return 0;
    let score = 50;
    if (user.isEmailVerified)
        score += 8;
    if (user.isPhoneVerified)
        score += 8;
    if (user.twoFactor?.enabled)
        score += 10;
    if (user.profile?.resumeUrl)
        score += 8;
    const reports = await Report_1.Report.countDocuments({
        subjectType: { $in: ['message', 'review'] },
        subjectId: userId,
        status: { $ne: 'dismissed' },
    });
    score -= reports * 6;
    if (user.isBanned)
        score = 0;
    user.security.trustScore = clamp(score);
    await user.save();
    return user.security.trustScore;
};
exports.recomputeUserTrust = recomputeUserTrust;
const trustBandLabel = (score) => {
    if (score >= 70)
        return 'high';
    if (score >= 40)
        return 'medium';
    return 'low';
};
exports.trustBandLabel = trustBandLabel;
