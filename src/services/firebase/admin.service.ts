/**
 * Centralised firebase-admin initialisation. Both the FCM push pipeline
 * and the Firebase Auth ID-token verifier go through this module so we
 * never end up with duplicate `initializeApp` calls or mismatched
 * credentials.
 *
 * The init is lazy — modules that only use one Firebase service won't
 * pay the credential-load cost until the first call.
 */

import fs from 'node:fs';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

type Admin = typeof import('firebase-admin');

let cached: Admin | null = null;
let initAttempted = false;

const loadServiceAccount = (): Record<string, unknown> | null => {
  if (env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    try {
      const raw = fs.readFileSync(env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      logger.error('firebase-admin: failed to read FIREBASE_SERVICE_ACCOUNT_PATH', err);
      return null;
    }
  }
  return null;
};

/**
 * Get the initialised firebase-admin module, or `null` if no
 * credentials are configured. Callers should treat `null` as "feature
 * disabled" rather than crashing.
 */
export const getFirebaseAdmin = async (): Promise<Admin | null> => {
  if (cached) return cached;
  if (initAttempted) return null;
  initAttempted = true;

  const credentials = loadServiceAccount();
  if (!credentials) {
    logger.info('firebase-admin: no service-account configured — Firebase features disabled');
    return null;
  }

  try {
    const admin = (await import('firebase-admin')).default;
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(credentials as Record<string, string>),
        projectId: env.FIREBASE_PROJECT_ID,
      });
      logger.info('firebase-admin initialised');
    }
    cached = admin;
    return admin;
  } catch (err) {
    logger.error('firebase-admin init failed', err);
    return null;
  }
};

export const isFirebaseConfigured = (): boolean =>
  Boolean(env.FIREBASE_SERVICE_ACCOUNT_PATH);
