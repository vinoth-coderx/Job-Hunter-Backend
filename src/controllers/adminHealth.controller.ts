import { Response } from 'express';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { redis } from '../config/redis';
import { getConnectionForMode } from '../config/dbConnections';
import { getAppConfig } from '../services/config/config.service';
import { AiKey } from '../models/AiKey';
import { env } from '../config/env';

type HealthState = 'ok' | 'warn' | 'down' | 'unknown';

interface Probe {
  name: string;
  state: HealthState;
  latencyMs?: number;
  detail?: string;
}

const probeMongo = async (): Promise<Probe> => {
  const start = Date.now();
  try {
    const test = getConnectionForMode('test');
    const live = getConnectionForMode('live');
    if (test.readyState !== 1 || live.readyState !== 1) {
      return {
        name: 'mongo',
        state: 'down',
        detail: `test=${test.readyState} live=${live.readyState}`,
      };
    }
    await Promise.all([
      test.db?.admin().ping(),
      live.db?.admin().ping(),
    ]);
    return { name: 'mongo', state: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      name: 'mongo',
      state: 'down',
      latencyMs: Date.now() - start,
      detail: (err as Error).message,
    };
  }
};

const probeRedis = async (): Promise<Probe> => {
  const start = Date.now();
  try {
    if (redis.status !== 'ready') {
      return { name: 'redis', state: 'down', detail: `status=${redis.status}` };
    }
    const pong = await redis.ping();
    return {
      name: 'redis',
      state: pong === 'PONG' ? 'ok' : 'warn',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'redis',
      state: 'down',
      latencyMs: Date.now() - start,
      detail: (err as Error).message,
    };
  }
};

const probeAi = async (): Promise<Probe> => {
  const count = await AiKey.countDocuments({ isActive: true });
  if (count === 0) {
    return {
      name: 'ai-providers',
      state: 'warn',
      detail: 'No active AI keys configured',
    };
  }
  return { name: 'ai-providers', state: 'ok', detail: `${count} active key(s)` };
};

const probeConfigKey = (
  name: string,
  key: string,
): Probe => {
  const v = getAppConfig(key);
  if (v && v.length > 0) {
    return { name, state: 'ok', detail: 'value present' };
  }
  return { name, state: 'warn', detail: `${key} not set` };
};

/**
 * Returns only the host (and optional db) portion of a Mongo connection
 * string, stripping credentials. Used for the admin Bootstrap secrets
 * card so an operator can see "where" Mongo is pointing without leaking
 * the password. Falls back to `***@unknown` on parse failure.
 */
const maskMongoUri = (uri: string): string => {
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}${url.pathname || ''}`;
  } catch {
    return '***@unknown';
  }
};

export const getAdminHealth = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    const probes: Probe[] = await Promise.all([
      probeMongo(),
      probeRedis(),
      probeAi(),
      Promise.resolve(probeConfigKey('cloudinary', 'CLOUDINARY_CLOUD_NAME')),
      Promise.resolve(probeConfigKey('firebase', 'FIREBASE_SERVICE_ACCOUNT_JSON')),
      Promise.resolve(probeConfigKey('razorpay', 'RAZORPAY_KEY_ID')),
      Promise.resolve(probeConfigKey('smtp', 'SMTP_USER')),
    ]);

    const downCount = probes.filter((p) => p.state === 'down').length;
    const warnCount = probes.filter((p) => p.state === 'warn').length;
    const overall: HealthState =
      downCount > 0 ? 'down' : warnCount > 0 ? 'warn' : 'ok';

    res.json({
      overall,
      probes,
      runtime: {
        nodeEnv: env.NODE_ENV,
        port: env.PORT,
        clientUrl: env.CLIENT_URL,
      },
      // Bootstrap secrets — values that MUST live in .env because they
      // gate the boot sequence (Mongo connect, JWT mint, AES decrypt of
      // app_configs). Surfaced read-only + masked so an admin can
      // confirm each is set without the value ever leaving the server.
      bootstrap: {
        mongo: {
          set: Boolean(env.MONGODB_URI),
          hostMasked: env.MONGODB_URI ? maskMongoUri(env.MONGODB_URI) : null,
          prodSet: Boolean(env.MONGODB_URI_PROD),
        },
        redis: {
          host: env.REDIS_HOST,
          port: env.REDIS_PORT,
          usernameSet: Boolean(env.REDIS_USERNAME),
          passwordSet: Boolean(env.REDIS_PASSWORD),
        },
        jwt: {
          secretSet: Boolean(env.JWT_SECRET),
          secretLength: env.JWT_SECRET?.length ?? 0,
          refreshSet: Boolean(env.JWT_REFRESH_SECRET),
          refreshLength: env.JWT_REFRESH_SECRET?.length ?? 0,
        },
        cryptoMasterKey: {
          set: Boolean(env.CRYPTO_MASTER_KEY),
          length: env.CRYPTO_MASTER_KEY?.length ?? 0,
        },
      },
      generatedAt: new Date().toISOString(),
    });
  },
);
