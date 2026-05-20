import { Response } from 'express';
import { z } from 'zod';
import { User } from '../models/User';
import { AiCreditTopUp } from '../models/AiCreditTopUp';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { logger } from '../utils/logger';
import {
  createRazorpayOrder,
  verifyPaymentSignature,
  fetchRazorpayOrder,
  getRazorpayKeyId,
} from '../services/razorpay.service';
import { getAppConfig } from '../services/config/config.service';
import { currentRuntimeMode } from '../config/dbConnections';

/**
 * AI credit top-up packs. Catalog is server-authoritative — the client
 * never passes price; it picks a pack id and we resolve credits + INR
 * here. Admins can override via AppConfig `AI_TOPUP_PACKS_JSON` (same
 * shape as the defaults below) to run promos without a code change.
 */
export interface AiTopUpPack {
  id: string;
  label: string;
  credits: number;
  priceInr: number;
  bestValue?: boolean;
}

const DEFAULT_PACKS: AiTopUpPack[] = [
  { id: 'starter', label: '50 credits', credits: 50, priceInr: 49 },
  {
    id: 'pro',
    label: '250 credits',
    credits: 250,
    priceInr: 199,
    bestValue: true,
  },
  { id: 'mega', label: '700 credits', credits: 700, priceInr: 499 },
];

const getPacks = (): AiTopUpPack[] => {
  const raw = getAppConfig('AI_TOPUP_PACKS_JSON');
  if (!raw) return DEFAULT_PACKS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_PACKS;
    const out: AiTopUpPack[] = [];
    for (const p of parsed) {
      if (!p || typeof p !== 'object') continue;
      const o = p as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      const label = typeof o.label === 'string' ? o.label.trim() : '';
      const credits =
        typeof o.credits === 'number' && Number.isFinite(o.credits)
          ? Math.round(o.credits)
          : 0;
      const priceInr =
        typeof o.priceInr === 'number' && Number.isFinite(o.priceInr)
          ? Math.round(o.priceInr)
          : 0;
      if (!id || !label || credits <= 0 || priceInr <= 0) continue;
      out.push({
        id,
        label,
        credits,
        priceInr,
        bestValue: o.bestValue === true,
      });
    }
    return out.length > 0 ? out : DEFAULT_PACKS;
  } catch {
    return DEFAULT_PACKS;
  }
};

export const findPack = (id: string): AiTopUpPack | undefined =>
  getPacks().find((p) => p.id === id);

export const listAiTopUpPacks = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    res.json({ success: true, data: getPacks() });
  },
);

export const createAiTopUpOrderSchema = z.object({
  body: z.object({
    packId: z.string().min(1).max(60),
  }),
});

/**
 * Create a Razorpay order for an AI top-up pack. Amount comes from the
 * server-side catalog — the client only sends the pack id. Notes record
 * { userId, packId, credits } so the verify path can re-derive the
 * grant without trusting the client.
 */
export const createAiTopUpOrder = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { packId } = req.body as { packId: string };
    const pack = findPack(packId);
    if (!pack) throw ApiError.badRequest('Unknown top-up pack');

    const order = await createRazorpayOrder({
      amountPaise: pack.priceInr * 100,
      currency: 'INR',
      receipt: `aitop_${req.user.id.slice(-12)}_${Date.now().toString(36)}`,
      notes: {
        userId: req.user.id,
        kind: 'ai_topup',
        packId: pack.id,
        credits: String(pack.credits),
      },
    });

    res.status(201).json({
      success: true,
      data: {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: getRazorpayKeyId(),
        packId: pack.id,
        credits: pack.credits,
        priceInr: pack.priceInr,
      },
    });
  },
);

export const verifyAiTopUpSchema = z.object({
  body: z.object({
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
  }),
});

/**
 * Verify a Razorpay top-up payment and grant credits. Defense layers
 * mirror the subscription verify path:
 *   1. HMAC signature check.
 *   2. Re-fetch the order and read userId/packId/credits from notes.
 *   3. Ownership match against the authenticated user.
 *   4. Amount match against the pack's current price.
 *   5. Idempotency via the unique `paymentId` index on AiCreditTopUp.
 */
export const verifyAiTopUpPayment = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body as {
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
    };

    const ok = verifyPaymentSignature({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
    });
    if (!ok) {
      logger.warn(
        `AI top-up signature mismatch user=${req.user.id} order=${razorpay_order_id}`,
      );
      throw ApiError.badRequest('Payment signature verification failed');
    }

    const order = await fetchRazorpayOrder(razorpay_order_id);
    const notes = order.notes ?? {};
    if (notes.kind !== 'ai_topup') {
      throw ApiError.badRequest('Order is not an AI top-up');
    }
    if (!notes.userId || notes.userId !== req.user.id) {
      throw ApiError.forbidden('Order does not belong to this user');
    }
    const packId = notes.packId;
    const pack = packId ? findPack(packId) : undefined;
    if (!pack) throw ApiError.badRequest('Order pack is no longer available');
    if (order.amount !== pack.priceInr * 100) {
      throw ApiError.badRequest('Order amount does not match pack price');
    }

    // Idempotency — same paymentId already credited.
    const existing = await AiCreditTopUp.findOne({
      paymentId: razorpay_payment_id,
    }).lean();
    if (existing) {
      const user = await User.findById(req.user.id)
        .select('aiTopUpCredits')
        .lean();
      res.json({
        success: true,
        data: {
          alreadyCredited: true,
          creditsGranted: existing.credits,
          balance: user?.aiTopUpCredits ?? 0,
        },
      });
      return;
    }

    let granted = false;
    try {
      await AiCreditTopUp.create({
        user: req.user.id,
        packId: pack.id,
        credits: pack.credits,
        amountInr: pack.priceInr,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        mode: currentRuntimeMode(),
      });
      granted = true;
    } catch (err) {
      // Unique-key clash means a concurrent /verify or webhook won the
      // race — treat as success and read the post-grant balance.
      logger.info(
        `AI top-up ledger insert race for ${razorpay_payment_id}: ${(err as Error).message}`,
      );
    }

    let balance = 0;
    if (granted) {
      const updated = await User.findByIdAndUpdate(
        req.user.id,
        { $inc: { aiTopUpCredits: pack.credits } },
        { new: true, projection: { aiTopUpCredits: 1 } },
      ).lean();
      balance = Number(updated?.aiTopUpCredits ?? 0);
    } else {
      const user = await User.findById(req.user.id)
        .select('aiTopUpCredits')
        .lean();
      balance = Number(user?.aiTopUpCredits ?? 0);
    }

    res.json({
      success: true,
      data: {
        alreadyCredited: !granted,
        creditsGranted: granted ? pack.credits : 0,
        balance,
      },
    });
  },
);

export const aiTopUpHistory = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const rows = await AiCreditTopUp.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: String(r._id),
        packId: r.packId,
        credits: r.credits,
        amountInr: r.amountInr,
        paymentId: r.paymentId,
        createdAt: r.createdAt,
      })),
    });
  },
);
