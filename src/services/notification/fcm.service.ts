/**
 * FCM push delivery via firebase-admin. Initialised lazily and only when
 * a service-account credential is configured — otherwise `sendToTokens`
 * resolves with `{ skipped: true }` so the alert cron can still run
 * without crashing in environments that don't have FCM set up.
 *
 * Setup (once Firebase project exists):
 *   1. Firebase Console → Project Settings → Service Accounts → Generate
 *      private key. Save the JSON.
 *   2. Set EITHER:
 *        FIREBASE_SERVICE_ACCOUNT_JSON='<paste the JSON here>'
 *      OR:
 *        FIREBASE_SERVICE_ACCOUNT_PATH=/abs/path/to/service-account.json
 *   3. Optionally FIREBASE_PROJECT_ID (otherwise picked up from the JSON).
 */

import fs from 'node:fs';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

type AdminApp = unknown;
let adminApp: AdminApp | null = null;
let initAttempted = false;

const loadServiceAccount = (): Record<string, unknown> | null => {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      logger.error('FCM: invalid FIREBASE_SERVICE_ACCOUNT_JSON', err);
      return null;
    }
  }
  if (env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    try {
      const raw = fs.readFileSync(env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      logger.error('FCM: failed to read FIREBASE_SERVICE_ACCOUNT_PATH', err);
      return null;
    }
  }
  return null;
};

const getAdmin = async (): Promise<typeof import('firebase-admin') | null> => {
  if (initAttempted) {
    return adminApp ? (await import('firebase-admin')).default : null;
  }
  initAttempted = true;

  const credentials = loadServiceAccount();
  if (!credentials) {
    logger.info('FCM: no service-account configured — push delivery disabled');
    return null;
  }

  try {
    const admin = (await import('firebase-admin')).default;
    adminApp = admin.initializeApp({
      credential: admin.credential.cert(credentials as Record<string, string>),
      projectId: env.FIREBASE_PROJECT_ID,
    });
    logger.info('FCM: firebase-admin initialised');
    return admin;
  } catch (err) {
    logger.error('FCM: firebase-admin init failed', err);
    return null;
  }
};

export interface PushResult {
  skipped?: boolean;
  successCount?: number;
  failureCount?: number;
  invalidTokens?: string[];
}

export const sendToTokens = async (
  tokens: string[],
  payload: { title: string; body: string; data?: Record<string, string> },
): Promise<PushResult> => {
  if (tokens.length === 0) return { successCount: 0, failureCount: 0 };
  const admin = await getAdmin();
  if (!admin) return { skipped: true };

  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
      android: {
        priority: 'high',
        notification: { channelId: 'job_alerts' },
      },
      apns: {
        payload: {
          aps: { sound: 'default' },
        },
      },
    });

    const invalidTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code ?? '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          invalidTokens.push(tokens[i]);
        }
      }
    });

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokens,
    };
  } catch (err) {
    logger.error('FCM: sendEachForMulticast failed', err);
    return { skipped: true };
  }
};
