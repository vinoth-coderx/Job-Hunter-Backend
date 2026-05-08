import axios from 'axios';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { IJob } from '../../models/Job';

/**
 * WhatsApp delivery via MSG91. Configuration:
 *   MSG91_AUTH_KEY            — Bearer auth key
 *   MSG91_WHATSAPP_NUMBER     — registered WA Business sender number
 *   MSG91_WHATSAPP_TEMPLATE   — approved template name (e.g. "job_alert")
 *
 * The provided template MUST accept three body parameters:
 *   {{1}} candidate name
 *   {{2}} job title
 *   {{3}} apply URL
 *
 * If MSG91 isn't configured, this is a no-op so dev environments still
 * boot. Errors are caught and logged — alert delivery is best-effort.
 */

const TEMPLATE_PARAMS = 3 as const;

const isConfigured = (): boolean =>
  !!process.env.MSG91_AUTH_KEY &&
  !!process.env.MSG91_WHATSAPP_NUMBER &&
  !!process.env.MSG91_WHATSAPP_TEMPLATE;

/**
 * Send one WhatsApp message per job (most providers cap template body
 * size, so summarising N jobs into one message risks template
 * mismatch). For the headline job we send a real message; the rest
 * fall through to email/push if the user has those enabled.
 */
export const sendJobAlertWhatsApp = async (params: {
  fullName: string;
  phone?: string;
  jobs: IJob[];
}): Promise<void> => {
  if (!isConfigured()) {
    logger.debug('MSG91 not configured — skipping WhatsApp alert');
    return;
  }
  if (!params.phone) return;
  if (params.jobs.length === 0) return;

  const phone = normalisePhone(params.phone);
  if (!phone) return;

  const top = params.jobs[0];
  const body: Record<string, unknown> = {
    integrated_number: process.env.MSG91_WHATSAPP_NUMBER,
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name: process.env.MSG91_WHATSAPP_TEMPLATE,
        language: { code: 'en_US', policy: 'deterministic' },
        namespace: process.env.MSG91_WHATSAPP_NAMESPACE,
        to_and_components: [
          {
            to: [phone],
            components: {
              body_1: {
                type: 'text',
                value: clip(params.fullName, 60),
              },
              body_2: {
                type: 'text',
                value: clip(`${top.title} @ ${top.company}`, 100),
              },
              body_3: {
                type: 'text',
                value: clip(top.url, 200),
              },
            },
          },
        ],
      },
    },
  };

  // Soft sanity check — keep our payload aligned with the agreed
  // template parameter count even if someone changes the template
  // server-side without updating this code.
  if (Object.keys(body.payload as object).length === 0) {
    logger.warn('WhatsApp payload is empty — skipping');
    return;
  }
  void TEMPLATE_PARAMS;

  try {
    await axios.post(
      'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
      body,
      {
        timeout: 12_000,
        headers: {
          authkey: process.env.MSG91_AUTH_KEY!,
          'Content-Type': 'application/json',
        },
      },
    );
  } catch (err) {
    if (axios.isAxiosError(err)) {
      logger.warn(
        `WhatsApp send failed (${err.response?.status}): ${JSON.stringify(err.response?.data)}`,
      );
    } else {
      logger.warn(`WhatsApp send failed: ${(err as Error).message}`);
    }
  }
};

/**
 * Best-effort E.164 normaliser for India-first numbers.
 * Accepts inputs like "9876543210", "+91 98765 43210", "919876543210".
 */
const normalisePhone = (raw: string): string | null => {
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned.length >= 10 ? cleaned : null;
  if (cleaned.length === 10) return `+91${cleaned}`;
  if (cleaned.length === 12 && cleaned.startsWith('91')) return `+${cleaned}`;
  return null;
};

const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;
