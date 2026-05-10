import { Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { User } from '../models/User';
import { Referral } from '../models/Referral';
import { ApiError } from '../utils/ApiError';
import { asyncHandler } from '../utils/asyncHandler';
import { AuthRequest } from '../types';
import { grantCoins } from '../services/coins/coin.service';
import { logger } from '../utils/logger';

// Referral coin economy. Both sides earn — keeps the share message
// genuine ("you also get coins") instead of feeling like one-sided
// affiliate spam.
const REFEREE_COIN_AMOUNT = 20;
const REFERRER_COIN_AMOUNT = 30;
// Per-referrer daily cap on referee claims. Bounds farming via burner
// signups; legit power-users rarely hit 10 referrals in a day.
const REFERRER_DAILY_CAP = 10 * REFERRER_COIN_AMOUNT; // 300 coins

// Code charset deliberately avoids ambiguous chars (0/O, 1/I/L).
const CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const generateCode = (): string => {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_CHARSET[bytes[i] % CODE_CHARSET.length];
  }
  return out;
};

/**
 * Lazily assigns a referralCode to the user on first call and returns
 * it. Subsequent calls return the same code so the seeker can share the
 * exact same link/QR every time.
 *
 * Race-safe: in the worst case two concurrent calls generate two codes,
 * one wins the unique index, the other retries up to 5 times.
 */
export const getMyReferralCode = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();

    const existing = await User.findById(req.user._id).select('referralCode');
    if (!existing) throw ApiError.notFound('User not found');
    if (existing.referralCode) {
      res.json({ success: true, data: { code: existing.referralCode } });
      return;
    }

    // Generate-and-claim loop. Unique index on referralCode is the
    // arbiter — we don't trust the readback above to be free of races.
    let attempt = 0;
    while (attempt < 5) {
      attempt += 1;
      const candidate = generateCode();
      try {
        const updated = await User.findOneAndUpdate(
          { _id: req.user._id, referralCode: { $exists: false } },
          { $set: { referralCode: candidate } },
          { new: true, projection: { referralCode: 1 } },
        );
        if (updated?.referralCode) {
          res.json({ success: true, data: { code: updated.referralCode } });
          return;
        }
        // The conditional update missed (another request landed first).
        // Re-read and return whatever's stored now.
        const reread = await User.findById(req.user._id).select('referralCode');
        if (reread?.referralCode) {
          res.json({ success: true, data: { code: reread.referralCode } });
          return;
        }
      } catch (err: unknown) {
        if (
          !(
            err &&
            typeof err === 'object' &&
            'code' in err &&
            (err as { code?: number }).code === 11000
          )
        ) {
          throw err;
        }
        // Code collision (E11000) — try a fresh candidate.
      }
    }
    throw ApiError.internal('Could not allocate a referral code');
  },
);

export const claimReferralSchema = z.object({
  body: z.object({
    code: z
      .string()
      .min(4)
      .max(12)
      .transform((s) => s.trim().toUpperCase()),
  }),
});

/**
 * Called by a freshly-signed-up seeker who has a referrer's code. On
 * success both sides receive coins. Idempotent at the Referral row level
 * — a single referee can only ever claim once.
 */
export const claimReferral = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { code } = req.body as z.infer<typeof claimReferralSchema>['body'];

    const referrer = await User.findOne({ referralCode: code }).select('_id');
    if (!referrer) throw ApiError.notFound('Invalid referral code');
    if (referrer._id.equals(req.user._id)) {
      throw ApiError.badRequest("You can't refer yourself");
    }

    // Pre-flight check so we can return a friendly message before
    // attempting the grant. The unique index on referee is still the
    // real guard.
    const existing = await Referral.findOne({ referee: req.user._id }).lean();
    if (existing) throw ApiError.conflict('Referral code already claimed');

    let referral;
    try {
      referral = await Referral.create({
        referrer: referrer._id,
        referee: req.user._id,
        codeUsed: code,
        refereeAmount: REFEREE_COIN_AMOUNT,
        referrerAmount: REFERRER_COIN_AMOUNT,
      });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: number }).code === 11000
      ) {
        throw ApiError.conflict('Referral code already claimed');
      }
      throw err;
    }

    // Both grants are best-effort relative to the Referral row: the row
    // is the source of truth that the referral happened. If one grant
    // fails (e.g. referrer hit their daily cap), the referee still gets
    // theirs — we don't want to deny the new user coins because the
    // sharer is over-quota.
    const refereeGrant = await grantCoins({
      user: req.user.id,
      amount: REFEREE_COIN_AMOUNT,
      source: 'referral_install',
      idempotencyKey: `referee:${referral._id.toString()}`,
      sourceRefId: referral._id.toString(),
    });

    const referrerGrant = await grantCoins({
      user: referrer._id,
      amount: REFERRER_COIN_AMOUNT,
      source: 'referral_share',
      idempotencyKey: `referrer:${referral._id.toString()}`,
      sourceRefId: referral._id.toString(),
      dailyCap: REFERRER_DAILY_CAP,
    });

    if (!refereeGrant.granted) {
      logger.warn(
        `Referee grant failed for referral ${referral._id}: ${refereeGrant.reason}`,
      );
    }
    if (!referrerGrant.granted) {
      logger.warn(
        `Referrer grant failed for referral ${referral._id}: ${referrerGrant.reason}`,
      );
    }

    res.status(201).json({
      success: true,
      message: 'Referral claimed',
      data: {
        coinsAwarded: refereeGrant.amount,
        coinsBalance: refereeGrant.balance,
      },
    });
  },
);
