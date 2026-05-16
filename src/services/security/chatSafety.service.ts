/**
 * Outgoing chat message safety scan. Runs before `Message.create` to
 * block obvious recruiter-scam / candidate-baiting patterns that would
 * otherwise let bad actors funnel users off-platform.
 *
 * Severity model:
 *   - 'high'   → hard block. Used for: payment requests inside chat,
 *                bank-detail exfiltration, MLM pyramid pitches.
 *   - 'medium' → soft block. WhatsApp/Telegram redirects, suspicious
 *                short-URL drops. Surfaced as "looks scammy" to the
 *                sender so legitimate users can rephrase.
 *   - 'low'    → log only. Generic scam keywords ("registration fee")
 *                that sometimes show up in legitimate context.
 *
 * The matchers are intentionally regex-only — fast, deterministic, no
 * AI roundtrip for every chat send. The job moderation engine
 * (services/security/moderation.service.ts) handles deeper job-posting
 * checks with AI fallbacks; chat messages don't need that complexity.
 */

export type ChatSafetyFlag =
  | 'asks_payment'
  | 'asks_bank_details'
  | 'mlm_pyramid'
  | 'whatsapp_telegram_redirect'
  | 'shortener_url'
  | 'scam_keywords';

export type ChatSafetySeverity = 'low' | 'medium' | 'high';

export interface ChatSafetyReport {
  flags: ChatSafetyFlag[];
  severity: ChatSafetySeverity;
  /** Sample of phrases that matched — surfaced in the audit log so
   *  admins can review patterns without scanning raw messages. */
  matchedTerms: string[];
  /** Short user-facing reason. Empty when severity === 'low'. */
  blockReason: string;
}

interface FlagPattern {
  flag: ChatSafetyFlag;
  severity: ChatSafetySeverity;
  matchers: Array<RegExp | string>;
}

// Lowercased plain strings AND case-insensitive regexes. We split by
// type so the matcher loop can use the right comparison without
// re-converting on every call.
const FLAGS: FlagPattern[] = [
  {
    flag: 'asks_payment',
    severity: 'high',
    matchers: [
      'pay ₹',
      'pay rs.',
      'paytm',
      'phonepe',
      'gpay',
      'upi id',
      'registration fee',
      'security deposit',
      'training fee',
      'kit charges',
      'pay first',
      'transfer fee',
      'razorpay link',
      /pay\s+(us\s+)?\d+\s+(rupees|inr|rs)/i,
    ],
  },
  {
    flag: 'asks_bank_details',
    severity: 'high',
    matchers: [
      'send your bank',
      'send aadhaar',
      'send pan card',
      'share your account',
      'account number',
      'ifsc code',
      'share otp',
      'send otp',
      /\bcard\s+(number|details)\b/i,
      /\bcvv\b/i,
    ],
  },
  {
    flag: 'mlm_pyramid',
    severity: 'high',
    matchers: [
      'multi level marketing',
      'pyramid',
      'downline',
      'referral chain',
      'forex trading',
      'crypto investment',
      'investment opportunity',
    ],
  },
  {
    flag: 'whatsapp_telegram_redirect',
    severity: 'medium',
    matchers: [
      /whatsapp\s*[:\-]?\s*\+?\d{10,}/i,
      /\bwa\.me\/\d+/i,
      /t\.me\//i,
      /telegram\s*[:\-]?\s*@?[\w_]+/i,
      /ping\s+me\s+on\s+(whatsapp|telegram)/i,
      /dm\s+me\s+on\s+(whatsapp|telegram)/i,
    ],
  },
  {
    flag: 'shortener_url',
    severity: 'medium',
    matchers: [
      /bit\.ly\//i,
      /tinyurl\.com\//i,
      /linktr\.ee\//i,
      /\.tk\/[\w-]+/i,
      /\.ml\/[\w-]+/i,
      /\.gq\/[\w-]+/i,
      /forms\.gle\/[\w-]+/i,
    ],
  },
  {
    flag: 'scam_keywords',
    severity: 'low',
    matchers: [
      'work from home guaranteed',
      'earn ₹50,000 daily',
      'no experience high salary',
      'data entry instant payout',
    ],
  },
];

const SEVERITY_RANK: Record<ChatSafetySeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const reasonFor = (flags: ChatSafetyFlag[]): string => {
  if (flags.includes('asks_payment')) {
    return "Messages asking candidates to pay aren't allowed.";
  }
  if (flags.includes('asks_bank_details')) {
    return "Don't ask for bank account, OTP, card, or Aadhaar details in chat.";
  }
  if (flags.includes('mlm_pyramid')) {
    return 'MLM / pyramid pitches violate platform policy.';
  }
  if (flags.includes('whatsapp_telegram_redirect')) {
    return "Stay on-platform — don't redirect candidates to WhatsApp or Telegram.";
  }
  if (flags.includes('shortener_url')) {
    return 'Short URLs and suspicious links are blocked from chat messages.';
  }
  return '';
};

export const scanChatMessage = (content: string): ChatSafetyReport => {
  const text = (content || '').toLowerCase();
  if (!text.trim()) {
    return {
      flags: [],
      severity: 'low',
      matchedTerms: [],
      blockReason: '',
    };
  }

  const flagSet = new Set<ChatSafetyFlag>();
  const matched: string[] = [];
  let severity: ChatSafetySeverity = 'low';

  for (const pattern of FLAGS) {
    for (const m of pattern.matchers) {
      const hit =
        typeof m === 'string' ? text.includes(m) : m.test(content);
      if (hit) {
        flagSet.add(pattern.flag);
        matched.push(typeof m === 'string' ? m : m.source);
        if (SEVERITY_RANK[pattern.severity] > SEVERITY_RANK[severity]) {
          severity = pattern.severity;
        }
        // One match per pattern is enough — we don't need to log
        // every variant the user wrote.
        break;
      }
    }
  }

  const flags = [...flagSet];
  return {
    flags,
    severity,
    matchedTerms: matched.slice(0, 8),
    blockReason: severity === 'low' ? '' : reasonFor(flags),
  };
};
