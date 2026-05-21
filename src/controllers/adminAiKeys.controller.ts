import { Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AiKey, IAiKey, AiProvider } from '../models/AiKey';
import { AiUsageLog } from '../models/AiUsageLog';
import { encryptSecret, decryptSecret } from '../utils/aesCrypto';
import {
  syncProviderToAppConfig,
  syncAllProvidersToAppConfig,
} from '../services/ai/aiKeySync.service';
import { getAppConfig } from '../services/config/config.service';
import { isProviderEnabled } from '../services/ai/providers';

/**
 * UTC instant of the most recent IST midnight (Asia/Kolkata = UTC+5:30,
 * no DST). Used to filter `AiUsageLog` rows logged "today" by the same
 * boundary the per-user / global quota service uses for reset.
 */
const istMidnightTodayUtc = (now = new Date()): Date => {
  const IST_OFFSET_MIN = 330;
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const istMidnight = Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    0,
    0,
    0,
  );
  return new Date(istMidnight - IST_OFFSET_MIN * 60_000);
};

const PROVIDERS: AiProvider[] = ['gemini', 'groq'];

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
    const since = istMidnightTodayUtc();
    const [keys, usageRows] = await Promise.all([
      AiKey.find({})
        .sort({ priority: 1, createdAt: -1 })
        .lean<IAiKey[]>(),
      // Live per-provider counts for *today* (since IST midnight) and the
      // most recent call timestamp. AiUsageLog is the source of truth —
      // the static `usageToday` field on AiKey was never incremented and
      // the per-call lookup of "which AiKey was used" doesn't exist on
      // the log row (we only carry the provider). Showing aggregated
      // provider usage on each key is honest and shared providers
      // typically only have one active key anyway.
      AiUsageLog.aggregate<{
        _id: AiProvider;
        callsToday: number;
        lastUsedAt: Date | null;
      }>([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: '$provider',
            callsToday: { $sum: 1 },
            lastUsedAt: { $max: '$createdAt' },
          },
        },
      ]),
    ]);

    const byProvider = new Map(
      usageRows.map((r) => [r._id, r] as const),
    );

    res.json({
      keys: keys.map((k) => {
        const live = byProvider.get(k.provider);
        return {
          ...toResponse(k),
          usageToday: live?.callsToday ?? 0,
          lastUsedAt: (live?.lastUsedAt ?? k.lastUsedAt)?.toISOString(),
        };
      }),
    });
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
    await syncProviderToAppConfig(created.provider);
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
    // Capture the pre-update provider so we can re-sync the old provider
    // if the admin migrated this key between providers (rare but valid).
    const before = await AiKey.findById(id).lean<IAiKey>();
    const updated = await AiKey.findByIdAndUpdate(id, parsed, {
      new: true,
    }).lean<IAiKey>();
    if (!updated) throw ApiError.notFound('AI key not found');
    await syncProviderToAppConfig(updated.provider);
    if (before && before.provider !== updated.provider) {
      await syncProviderToAppConfig(before.provider);
    }
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
    await syncProviderToAppConfig(updated.provider);
    res.json(toResponse(updated));
  },
);

export const deleteAiKey = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const id = requireObjectId(req.params.id);
    // Capture the provider so we can re-sync after deletion (the winner
    // for this provider may now be a different key, or none at all).
    const doomed = await AiKey.findById(id).lean<IAiKey>();
    const r = await AiKey.deleteOne({ _id: id });
    if (r.deletedCount === 0) throw ApiError.notFound('AI key not found');
    if (doomed) await syncProviderToAppConfig(doomed.provider);
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
      if (k.provider === 'groq') {
        // Groq is OpenAI-compatible; the /models endpoint accepts a
        // Bearer token and doesn't spend any tokens. Same shape as the
        // gemini/claude branches above.
        const base = (k.baseUrl?.trim() || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
        const resp = await fetch(`${base}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
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

/**
 * Re-run the AiKey → AppConfig bridge for every provider and return a
 * per-provider report. Useful when the boot-time sync missed something
 * (server was offline when the admin added a key, encrypt key rotated,
 * AiKey rows became inactive, etc.) — the operator hits this to make
 * the runtime providers see the current AiKey state without restarting
 * the process. Report shape lets the admin UI render a
 * traffic-light per provider:
 *
 *   { gemini: { keyRowsTotal, activeRows, syncedToAppConfig, providerEnabled }, ... }
 */
export const syncAiKeysToAppConfig = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    await syncAllProvidersToAppConfig();
    const APP_CFG: Record<AiProvider, string> = {
      gemini: 'GEMINI_API_KEY',
      groq: 'GROQ_API_KEY',
    };
    const report: Record<AiProvider, {
      keyRowsTotal: number;
      activeRows: number;
      syncedToAppConfig: boolean;
      providerEnabled: boolean;
    }> = { gemini: {} as never, groq: {} as never };
    for (const p of PROVIDERS) {
      const [keyRowsTotal, activeRows] = await Promise.all([
        AiKey.countDocuments({ provider: p }),
        AiKey.countDocuments({ provider: p, isActive: true }),
      ]);
      report[p] = {
        keyRowsTotal,
        activeRows,
        syncedToAppConfig: Boolean(getAppConfig(APP_CFG[p])),
        providerEnabled: isProviderEnabled(p),
      };
    }
    res.json({ ok: true, report });
  },
);
