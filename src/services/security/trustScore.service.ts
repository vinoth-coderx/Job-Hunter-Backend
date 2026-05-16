import { HirerProfile, IHirerProfile } from '../../models/HirerProfile';
import { Job } from '../../models/Job';
import { Report } from '../../models/Report';
import { JobModeration } from '../../models/JobModeration';
import { User } from '../../models/User';
import mongoose from 'mongoose';

// Recomputes a recruiter's trust score from observable signals.
// Designed to be idempotent so the nightly cron and ad-hoc admin runs
// both produce the same answer. Score is anchored at 50 (neutral) and
// shifted by positive/negative signals.

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

export const recomputeHirerTrust = async (hirerId: string | mongoose.Types.ObjectId): Promise<number> => {
  const hirer = await HirerProfile.findOne({ user: hirerId });
  if (!hirer) return 0;

  let score = 50;

  // Verification gives the biggest single positive signal.
  if (hirer.verification.levels.gst) score += 12;
  if (hirer.verification.levels.domainEmail) score += 10;
  if (hirer.verification.levels.website) score += 6;
  if (hirer.verification.levels.linkedin) score += 6;
  if (hirer.verification.levels.identity) score += 8;

  // Posting volume — only counts if jobs aren't being repeatedly flagged.
  const jobsPosted = await Job.countDocuments({ postedBy: hirerId, isNative: true });
  score += Math.min(8, Math.floor(jobsPosted / 5));

  // Negative signals
  const flagged = await JobModeration.countDocuments({
    hirer: hirerId,
    decision: { $in: ['auto_rejected', 'queued'] },
  });
  score -= flagged * 3;

  const reportsAgainst = await Report.countDocuments({
    subjectType: 'recruiter',
    subjectId: hirerId,
    status: { $ne: 'dismissed' },
  });
  score -= reportsAgainst * 6;

  if (hirer.approvalStatus === 'suspended') score -= 25;
  if (hirer.approvalStatus === 'banned') score = 0;

  hirer.trustScore = clamp(score);
  hirer.totalJobsPosted = jobsPosted;
  hirer.totalJobsFlagged = flagged;
  hirer.totalReportsAgainst = reportsAgainst;

  // Posting limits scale with trust.
  if (hirer.trustScore >= 80) hirer.dailyPostLimit = 50;
  else if (hirer.trustScore >= 60) hirer.dailyPostLimit = 15;
  else if (hirer.trustScore >= 40) hirer.dailyPostLimit = 5;
  else hirer.dailyPostLimit = 2;

  await hirer.save();
  return hirer.trustScore;
};

export const recomputeUserTrust = async (userId: string | mongoose.Types.ObjectId): Promise<number> => {
  const user = await User.findById(userId);
  if (!user) return 0;
  let score = 50;
  if (user.isEmailVerified) score += 8;
  if (user.isPhoneVerified) score += 8;
  if (user.twoFactor?.enabled) score += 10;
  if (user.profile?.resumeUrl) score += 8;
  const reports = await Report.countDocuments({
    subjectType: { $in: ['message', 'review'] },
    subjectId: userId,
    status: { $ne: 'dismissed' },
  });
  score -= reports * 6;
  if (user.isBanned) score = 0;
  user.security.trustScore = clamp(score);
  await user.save();
  return user.security.trustScore;
};

export const trustBandLabel = (score: number): 'low' | 'medium' | 'high' => {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
};
