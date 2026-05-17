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
import { getAppConfig } from '../config/config.service';
import { logger } from '../../utils/logger';

type Admin = typeof import('firebase-admin');

let cached: Admin | null = null;
let initAttempted = false;

/**
 * Resolve the Firebase service-account credentials. Priority:
 *   1. `FIREBASE_SERVICE_ACCOUNT_JSON` (AppConfig or env) — raw JSON
 *      blob; preferred since the secret itself lives in the DB.
 *   2. `FIREBASE_SERVICE_ACCOUNT_PATH` (env only) — filesystem path,
 *      retained for local-dev workflows where the JSON file is checked
 *      out next to the repo.
 */
const loadServiceAccount = (): Record<string, unknown> | null => {
  const jsonBlob = getAppConfig('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (jsonBlob) {
    try {
      return JSON.parse(jsonBlob) as Record<string, unknown>;
    } catch (err) {
      logger.error('firebase-admin: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON', err);
      return null;
    }
  }
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (path) {
    try {
      const raw = fs.readFileSync(path, 'utf8');
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
        projectId: getAppConfig('FIREBASE_PROJECT_ID') ?? undefined,
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
  Boolean(getAppConfig('FIREBASE_SERVICE_ACCOUNT_JSON')) ||
  Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

/**
 * Drop the cached firebase-admin instance + delete the underlying app so
 * the next `getFirebaseAdmin()` re-reads credentials from scratch.
 * Called when the runtime mode flips so the live mode's service account
 * doesn't keep serving requests after a switch to test mode (or vice
 * versa). Safe to call when nothing is initialised — both branches are
 * no-ops then.
 */
export const resetFirebaseAdmin = async (): Promise<void> => {
  if (cached) {
    try {
      await Promise.all(cached.apps.map((app) => app?.delete()));
    } catch (err) {
      logger.warn('firebase-admin: app.delete() failed during reset', err);
    }
  }
  cached = null;
  initAttempted = false;
};
