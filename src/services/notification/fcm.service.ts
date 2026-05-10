/**
 * FCM push delivery — uses the shared `firebase-admin` instance from
 * `services/firebase/admin.service.ts`. When no service-account is
 * configured, `sendToTokens` resolves with `{ skipped: true }` so the
 * alert cron can still run without crashing.
 */

import { logger } from '../../utils/logger';
import { getFirebaseAdmin } from '../firebase/admin.service';

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
  const admin = await getFirebaseAdmin();
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
