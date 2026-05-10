import { Response } from 'express';
import { User } from '../models/User';
import { AppliedJob } from '../models/AppliedJob';
import { SavedJob } from '../models/SavedJob';
import { SkillAssessment } from '../models/SkillAssessment';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { completenessFromUser } from '../services/profile/completeness.service';
import { grantCoins } from '../services/coins/coin.service';

// Daily check-in coin economy. Conservative defaults — see project memory
// "Coin economy default values" for the agreed table.
const CHECKIN_COIN_BASE = 10;
const CHECKIN_COIN_PER_STREAK_DAY = 5;
const CHECKIN_COIN_CAP = 30;

const computeCheckinReward = (streakCount: number): number => {
  const reward = CHECKIN_COIN_BASE + (streakCount - 1) * CHECKIN_COIN_PER_STREAK_DAY;
  return Math.max(CHECKIN_COIN_BASE, Math.min(CHECKIN_COIN_CAP, reward));
};

const dateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

interface BadgeDef {
  id: string;
  title: string;
  description: string;
  category: 'profile' | 'apply' | 'engagement' | 'mastery';
  evaluate: (ctx: BadgeContext) => boolean;
}

interface BadgeContext {
  appliedCount: number;
  savedCount: number;
  skillCount: number;
  completion: number;
  streakCount: number;
  passedAssessments: number;
}

const BADGES: BadgeDef[] = [
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

const buildContext = async (userId: string): Promise<BadgeContext> => {
  const user = await User.findById(userId).lean();
  if (!user) throw ApiError.notFound('User not found');

  const [appliedCount, savedCount, passedAssessments] = await Promise.all([
    AppliedJob.countDocuments({ user: userId }),
    SavedJob.countDocuments({ user: userId }),
    SkillAssessment.countDocuments({ user: userId, isPassed: true }),
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

export const listBadges = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const ctx = await buildContext(req.user.id);
  const badges = BADGES.map((b) => ({
    id: b.id,
    title: b.title,
    description: b.description,
    category: b.category,
    unlocked: b.evaluate(ctx),
  }));

  // Persist any newly-unlocked badges so we can stamp earnedAt for streak
  // milestones / hirers / future leaderboards. Best-effort.
  try {
    const user = await User.findById(req.user._id).select('gamification.earnedBadges');
    if (user) {
      const haveSet = new Set(user.gamification.earnedBadges.map((b) => b.badgeId));
      const newlyEarned = badges.filter((b) => b.unlocked && !haveSet.has(b.id));
      if (newlyEarned.length > 0) {
        user.gamification.earnedBadges.push(
          ...newlyEarned.map((b) => ({ badgeId: b.id, earnedAt: new Date() })),
        );
        await user.save();
      }
    }
  } catch {
    // ignore
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

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const isYesterday = (last: Date, today: Date) => {
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  return sameDay(last, y);
};

export const checkInStreak = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound('User not found');

  const today = new Date();
  const last = user.gamification.lastCheckinDate;

  let streakChanged = false;
  if (!last) {
    user.gamification.streakCount = 1;
    streakChanged = true;
  } else if (sameDay(last, today)) {
    // Already checked in today — streak unchanged.
  } else if (isYesterday(last, today)) {
    user.gamification.streakCount += 1;
    streakChanged = true;
  } else {
    // Gap detected — streak resets.
    user.gamification.streakCount = 1;
    streakChanged = true;
  }
  if (user.gamification.streakCount > user.gamification.longestStreak) {
    user.gamification.longestStreak = user.gamification.streakCount;
  }
  user.gamification.lastCheckinDate = today;
  await user.save();

  // Coin grant — only when this is a fresh day's check-in (not the
  // already-checked-in-today branch). The ledger's idempotency key
  // also blocks same-day replays as a belt-and-braces guard if the
  // streakChanged flag ever drifts from the actual ledger state.
  let coinsAwarded = 0;
  let coinsBalance = user.gamification.coins ?? 0;
  if (streakChanged) {
    const reward = computeCheckinReward(user.gamification.streakCount);
    const grant = await grantCoins({
      user: user._id,
      amount: reward,
      source: 'checkin',
      idempotencyKey: `checkin:${dateKey(today)}`,
      meta: { streakCount: user.gamification.streakCount },
    });
    coinsAwarded = grant.amount;
    coinsBalance = grant.balance;
  }

  res.json({
    success: true,
    data: {
      streakCount: user.gamification.streakCount,
      longestStreak: user.gamification.longestStreak,
      lastCheckinDate: user.gamification.lastCheckinDate,
      streakChanged,
      coinsAwarded,
      coinsBalance,
    },
  });
});

export const getCoins = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id)
    .select('gamification.coins')
    .lean();
  if (!user) throw ApiError.notFound('User not found');

  res.json({
    success: true,
    data: {
      balance: user.gamification?.coins ?? 0,
    },
  });
});

export const getStreak = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id)
    .select('gamification')
    .lean();
  if (!user) throw ApiError.notFound('User not found');

  const today = new Date();
  const last = user.gamification?.lastCheckinDate
    ? new Date(user.gamification.lastCheckinDate)
    : undefined;
  // The cron-free way to detect a broken streak: if `last` is older
  // than yesterday, we lazily report the streak as 0 even before the
  // user opens the app to check in again.
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
