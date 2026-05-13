import { Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AiKey, IAiKey, AiProvider } from '../models/AiKey';
import { encryptSecret, decryptSecret } from '../utils/aesCrypto';

const PROVIDERS: AiProvider[] = ['gemini', 'claude'];

/** Strip the encrypted key before returning to the admin UI — it never
 * round-trips. The UI works off the document fields it can safely see.
 */
const toResponse = (k: Pick<IAiKey, Exclude<keyof IAiKey, 'apiKeyEncrypted'>>) => ({
  _id: k._id.toString(),
  provider: k.provider,
  label: k.label,
  model: k.model,
  baseUrl: k.baseUrl,
  priority: k.priority,
  weight: k.weight,
  tier: k.tier,
  dailyLimit: k.dailyLimit,
  rpmLimit: k.rpmLimit,
  maxTokens: k.maxTokens,
  temperature: k.temperature,
  allowedFeatures: k.allowedFeatures ?? [],
  notes: k.notes,
  isActive: k.isActive,
  usageToday: k.usageToday ?? 0,
  lastUsedAt: k.lastUsedAt?.toISOString(),
  createdAt: k.createdAt.toISOString(),
});

const requireObjectId = (id: unknown): Types.ObjectId => {
  if (typeof id !== 'string' || !Types.ObjectId.isValid(id)) {
    throw ApiError.badRequest('Invalid AI key id');
  }
  return new Types.ObjectId(id);
};

interface FormBody {
  provider?: unknown;
  label?: unknown;
  apiKey?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  priority?: unknown;
  weight?: unknown;
  tier?: unknown;
  dailyLimit?: unknown;
  rpmLimit?: unknown;
  maxTokens?: unknown;
  temperature?: unknown;
  allowedFeatures?: unknown;
  notes?: unknown;
  isActive?: unknown;
}

const parseBody = (
  body: FormBody,
  { requireApiKey }: { requireApiKey: boolean },
) => {
  const out: Partial<IAiKey> & { apiKeyEncrypted?: string } = {};
  if (body.provider !== undefined) {
    if (!PROVIDERS.includes(body.provider as AiProvider)) {
      throw ApiError.badRequest(`provider must be one of ${PROVIDERS.join(', ')}`);
    }
    out.provider = body.provider as AiProvider;
  }
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || !body.label.trim()) {
      throw ApiError.badRequest('label is required');
    }
    out.label = body.label.trim();
  }
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    out.apiKeyEncrypted = encryptSecret(body.apiKey.trim());
  } else if (requireApiKey) {
    throw ApiError.badRequest('apiKey is required for new entries');
  }
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !body.model.trim()) {
      throw ApiError.badRequest('model is required');
    }
    out.model = body.model.trim();
  }
  if (body.baseUrl !== undefined) {
    out.baseUrl =
      typeof body.baseUrl === 'string' && body.baseUrl.trim()
        ? body.baseUrl.trim()
        : undefined;
  }
  if (body.priority !== undefined) {
    const n = Number(body.priority);
    if (!Number.isFinite(n)) throw ApiError.badRequest('priority must be a number');
    out.priority = Math.max(0, n);
  }
  if (body.weight !== undefined) {
    const n = Number(body.weight);
    if (!Number.isFinite(n)) throw ApiError.badRequest('weight must be a number');
    out.weight = Math.max(0, n);
  }
  if (body.tier !== undefined) {
    if (body.tier !== 'free' && body.tier !== 'paid') {
      throw ApiError.badRequest('tier must be "free" or "paid"');
    }
    out.tier = body.tier;
  }
  if (body.dailyLimit !== undefined) {
    const n = Number(body.dailyLimit);
    if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest('dailyLimit must be >= 0');
    out.dailyLimit = n;
  }
  if (body.rpmLimit !== undefined) {
    const n = Number(body.rpmLimit);
    if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest('rpmLimit must be >= 0');
    out.rpmLimit = n;
  }
  if (body.maxTokens !== undefined) {
    out.maxTokens =
      body.maxTokens === null || body.maxTokens === ''
        ? undefined
        : Number(body.maxTokens);
  }
  if (body.temperature !== undefined) {
    out.temperature =
      body.temperature === null || body.temperature === ''
        ? undefined
        : Number(body.temperature);
  }
  if (body.allowedFeatures !== undefined) {
    if (!Array.isArray(body.allowedFeatures)) {
      throw ApiError.badRequest('allowedFeatures must be an array of strings');
    }
    out.allowedFeatures = body.allowedFeatures.filter(
      (f): f is string => typeof f === 'string',
    );
  }
  if (body.notes !== undefined) {
    out.notes =
      typeof body.notes === 'string' && body.notes.trim()
        ? body.notes.trim()
        : undefined;
  }
  if (body.isActive !== undefined) {
    out.isActive = Boolean(body.isActive);
  }
  return out;
};

export const listAiKeys = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    const keys = await AiKey.find({})
      .sort({ priority: 1, createdAt: -1 })
      .lean<IAiKey[]>();
    res.json({ keys: keys.map((k) => toResponse(k)) });
  },
);

export const createAiKey = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const parsed = parseBody(req.body ?? {}, { requireApiKey: true });
    if (!parsed.provider || !parsed.label || !parsed.model) {
      throw ApiError.badRequest('provider, label and model are required');
    }
    const created = await AiKey.create({
      ...parsed,
      createdBy: req.user?._id,
    });
    const lean = created.toObject();
    res.json(toResponse(lean as unknown as IAiKey));
  },
);

export const updateAiKey = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = requireObjectId(req.params.id);
    const parsed = parseBody(req.body ?? {}, { requireApiKey: false });
    if (Object.keys(parsed).length === 0) {
      throw ApiError.badRequest('No updatable fields supplied');
    }
    const updated = await AiKey.findByIdAndUpdate(id, parsed, {
      new: true,
    }).lean<IAiKey>();
    if (!updated) throw ApiError.notFound('AI key not found');
    res.json(toResponse(updated));
  },
);

export const toggleAiKey = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = requireObjectId(req.params.id);
    const { isActive } = req.body ?? {};
    if (typeof isActive !== 'boolean') {
      throw ApiError.badRequest('isActive must be a boolean');
    }
    const updated = await AiKey.findByIdAndUpdate(
      id,
      { isActive },
      { new: true },
    ).lean<IAiKey>();
    if (!updated) throw ApiError.notFound('AI key not found');
    res.json(toResponse(updated));
  },
);

export const deleteAiKey = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = requireObjectId(req.params.id);
    const r = await AiKey.deleteOne({ _id: id });
    if (r.deletedCount === 0) throw ApiError.notFound('AI key not found');
    res.json({ ok: true });
  },
);

/**
 * Lightweight upstream test for a stored key. Decrypts the ciphertext,
 * pings the provider's list-models endpoint (cheap, no token spend),
 * and reports ok/fail + latency. Failures don't mutate any usage counters.
 */
export const testAiKey = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = requireObjectId(req.params.id);
    const k = await AiKey.findById(id).select('+apiKeyEncrypted').lean<IAiKey>();
    if (!k) throw ApiError.notFound('AI key not found');

    let apiKey: string;
    try {
      apiKey = decryptSecret(k.apiKeyEncrypted);
    } catch {
      res.json({ ok: false, detail: 'Stored key is corrupt or master key changed' });
      return;
    }

    const start = Date.now();
    try {
      if (k.provider === 'gemini') {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
          { method: 'GET' },
        );
        const ok = resp.ok;
        if (!ok) {
          const body = await resp.text().catch(() => '');
          res.json({
            ok: false,
            latencyMs: Date.now() - start,
            detail: `${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 120)}` : ''}`,
          });
          return;
        }
        res.json({ ok: true, latencyMs: Date.now() - start });
        return;
      }
      // Claude: hit the models endpoint with the x-api-key header.
      const resp = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        res.json({
          ok: false,
          latencyMs: Date.now() - start,
          detail: `${resp.status} ${resp.statusText}${body ? ` — ${body.slice(0, 120)}` : ''}`,
        });
        return;
      }
      res.json({ ok: true, latencyMs: Date.now() - start });
    } catch (err) {
      res.json({
        ok: false,
        latencyMs: Date.now() - start,
        detail: (err as Error).message,
      });
    }
  },
);
