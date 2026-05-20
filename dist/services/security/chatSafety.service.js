"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanChatMessage = void 0;
const FLAGS = [
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
const SEVERITY_RANK = {
    low: 0,
    medium: 1,
    high: 2,
};
const reasonFor = (flags) => {
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
const scanChatMessage = (content) => {
    const text = (content || '').toLowerCase();
    if (!text.trim()) {
        return {
            flags: [],
            severity: 'low',
            matchedTerms: [],
            blockReason: '',
        };
    }
    const flagSet = new Set();
    const matched = [];
    let severity = 'low';
    for (const pattern of FLAGS) {
        for (const m of pattern.matchers) {
            const hit = typeof m === 'string' ? text.includes(m) : m.test(content);
            if (hit) {
                flagSet.add(pattern.flag);
                matched.push(typeof m === 'string' ? m : m.source);
                if (SEVERITY_RANK[pattern.severity] > SEVERITY_RANK[severity]) {
                    severity = pattern.severity;
                }
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
exports.scanChatMessage = scanChatMessage;
