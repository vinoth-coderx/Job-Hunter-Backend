import axios from 'axios';
import { getAppConfig } from '../config/config.service';
import { logger } from '../../utils/logger';

/**
 * Transactional SMS delivery. Today routes through MSG91's flow API
 * (cheapest TRAI-compliant option in India); swap providers by
 * replacing the body of `sendSms` — the calling sites only know the
 * `{ to, message }` contract.
 *
 * Configuration (AppConfig):
 *   MSG91_AUTH_KEY        — Bearer auth key (shared with whatsapp.service)
 *   MSG91_SMS_SENDER_ID   — 6-char approved sender id (e.g. "JBHNTR")
 *   MSG91_SMS_TEMPLATE_ID — DLT-registered template id for OTPs
 *
 * Unconfigured → no-op (dev environments + envs still in private beta).
 * Returns true only when the gateway accepted the message.
 */

const isConfigured = (): boolean =>
  !!getAppConfig('MSG91_AUTH_KEY') &&
  !!getAppConfig('MSG91_SMS_SENDER_ID') &&
  !!getAppConfig('MSG91_SMS_TEMPLATE_ID');

const normalisePhone = (raw: string): string | null => {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return null;
};

export interface SendSmsInput {
  to: string;
  message: string;
  // OTP-specific: template variables passed to the DLT template body.
  // For MSG91 flow templates the variables are referenced as ##otp##,
  // ##name##, etc — callers pass the matching keys.
  variables?: Record<string, string>;
}

export const sendSms = async (input: SendSmsInput): Promise<boolean> => {
  if (!isConfigured()) {
    logger.debug('SMS gateway not configured — skipping send');
    return false;
  }
  const phone = normalisePhone(input.to);
  if (!phone) {
    logger.warn(`[sms] invalid phone, dropping: ${input.to}`);
    return false;
  }
  try {
    await axios.post(
      'https://control.msg91.com/api/v5/flow/',
      {
        template_id: getAppConfig('MSG91_SMS_TEMPLATE_ID'),
        sender: getAppConfig('MSG91_SMS_SENDER_ID'),
        short_url: '0',
        recipients: [
          {
            mobiles: phone,
            ...(input.variables ?? { msg: input.message }),
          },
        ],
      },
      {
        timeout: 5000,
        headers: {
          authkey: getAppConfig('MSG91_AUTH_KEY')!,
          'content-type': 'application/json',
        },
      },
    );
    return true;
  } catch (err) {
    logger.warn(`[sms] gateway send failed: ${(err as Error).message}`);
    return false;
  }
};

/** Convenience helper for the OTP service. */
export const sendOtpSms = async (phone: string, code: string): Promise<boolean> =>
  sendSms({
    to: phone,
    message: `Your Job Hunter verification code is ${code}. It expires in 10 minutes.`,
    variables: { otp: code },
  });
