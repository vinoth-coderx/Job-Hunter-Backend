import type { AppConfigCategory } from '../../models/AppConfig';

/**
 * The canonical catalog of every admin-managed config key the backend
 * reads (or expects to read). The admin UI uses this to power a
 * "suggested keys" dropdown on the /config page so an operator doesn't
 * have to remember exact key names or guess at categories.
 *
 * Add an entry here whenever you wire a new `getAppConfig('FOO')` call —
 * keeps discoverability honest and gives the admin UI a default category
 * + description + secret flag to seed the form with.
 *
 * This is documentation-as-code, not behavior: the runtime still reads
 * via `getAppConfig`, which transparently falls back to `process.env`.
 * Removing an entry here doesn't break anything; it just hides the key
 * from the suggested-keys dropdown.
 */
export interface ConfigRegistryEntry {
  key: string;
  category: AppConfigCategory;
  isSecret: boolean;
  /** Human-readable purpose, shown as the form hint. */
  description: string;
  /** Default value if neither AppConfig nor env defines this key. */
  defaultValue?: string;
  /** Where in the codebase this key is read (for the "Used by" hint). */
  usedBy?: string;
}

export const CONFIG_REGISTRY: ConfigRegistryEntry[] = [
  // ── Job-board APIs ──────────────────────────────────────────────────
  {
    key: 'ADZUNA_APP_ID',
    category: 'job-board',
    isSecret: false,
    description: 'Adzuna API app_id. Sign up at developer.adzuna.com (250 calls/month free).',
    usedBy: 'services/scrapers/adzuna.service.ts',
  },
  {
    key: 'ADZUNA_APP_KEY',
    category: 'job-board',
    isSecret: true,
    description: 'Adzuna API app_key paired with ADZUNA_APP_ID.',
    usedBy: 'services/scrapers/adzuna.service.ts',
  },
  {
    key: 'OPENWEBNINJA_API_KEY',
    category: 'job-board',
    isSecret: true,
    description:
      'OpenWebNinja API key — powers JSearch (job board API) + Real-Time Web Search. Sign up at app.openwebninja.com.',
    usedBy: 'services/scrapers/rapidapi.service.ts, services/scrapers/realtimeWebSearch.service.ts',
  },
  {
    key: 'RAPIDAPI_KEY',
    category: 'job-board',
    isSecret: true,
    description:
      'Legacy RapidAPI key for JSearch. Falls back to this when OPENWEBNINJA_API_KEY is unset. Prefer the OpenWebNinja key.',
    usedBy: 'services/scrapers/rapidapi.service.ts',
  },
  {
    key: 'SERPAPI_KEY',
    category: 'job-board',
    isSecret: true,
    description: 'SerpAPI key for Google Jobs (100 calls/month free).',
    usedBy: 'services/scrapers/serpapi.service.ts',
  },

  // ── AI providers ────────────────────────────────────────────────────
  // The three *_API_KEY entries are written by the AiKey → AppConfig
  // bridge on /ai page saves — manual entry here is the legacy path.
  {
    key: 'GEMINI_API_KEY',
    category: 'ai',
    isSecret: true,
    description: 'Google AI Studio API key. Prefer adding via /ai page (auto-syncs from AiKey).',
    usedBy: 'services/ai/providers/gemini.provider.ts',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    category: 'ai',
    isSecret: true,
    description: 'Anthropic Claude API key. Prefer adding via /ai page.',
    usedBy: 'services/ai/providers/claude.provider.ts',
  },
  {
    key: 'GROQ_API_KEY',
    category: 'ai',
    isSecret: true,
    description: 'Groq (Llama) API key. Prefer adding via /ai page.',
    usedBy: 'services/ai/providers/groq.provider.ts',
  },
  {
    key: 'GROQ_BASE_URL',
    category: 'ai',
    isSecret: false,
    description: 'Override Groq base URL (e.g. self-hosted proxy). Defaults to api.groq.com.',
    defaultValue: 'https://api.groq.com/openai/v1',
    usedBy: 'services/ai/providers/groq.provider.ts',
  },
  {
    key: 'GROQ_MODEL_LITE',
    category: 'ai',
    isSecret: false,
    description: 'Groq model used for cheap/fast lane (moderation triage, skill extraction).',
    defaultValue: 'llama-3.1-8b-instant',
    usedBy: 'services/ai/providers/groq.provider.ts',
  },
  {
    key: 'GROQ_MODEL_SMART',
    category: 'ai',
    isSecret: false,
    description: 'Groq model used for the smart tier (larger Llama).',
    defaultValue: 'llama-3.3-70b-versatile',
    usedBy: 'services/ai/providers/groq.provider.ts',
  },
  {
    key: 'AI_PROVIDER',
    category: 'ai',
    isSecret: false,
    description: 'Default provider when no caller-side preference is set. One of: gemini, claude, groq.',
    defaultValue: 'gemini',
    usedBy: 'services/ai/providers/index.ts',
  },
  {
    key: 'AI_CREDIT_WEIGHTS_JSON',
    category: 'ai',
    isSecret: false,
    description: 'JSON map of feature → credit cost. Overrides the per-feature defaults (chat=1, ats=3, applicant_rank=5).',
    usedBy: 'services/ai/quota.service.ts',
  },
  {
    key: 'AI_COST_ALERT_ENABLED',
    category: 'ai',
    isSecret: false,
    description: 'Set to "true" to email AI_COST_ALERT_RECIPIENTS when 30-day spend exceeds AI_COST_ALERT_USD_30D.',
    defaultValue: 'false',
    usedBy: 'jobs/aiCostAlert.cron.ts',
  },
  {
    key: 'AI_COST_ALERT_USD_30D',
    category: 'ai',
    isSecret: false,
    description: 'Cost threshold (USD) over the trailing 30 days that triggers the alert email.',
    defaultValue: '50',
    usedBy: 'jobs/aiCostAlert.cron.ts',
  },
  {
    key: 'AI_COST_ALERT_RECIPIENTS',
    category: 'ai',
    isSecret: false,
    description: 'Comma-separated emails to notify when the cost threshold is breached.',
    usedBy: 'jobs/aiCostAlert.cron.ts',
  },
  {
    key: 'AI_TOPUP_PACKS_JSON',
    category: 'ai',
    isSecret: false,
    description: 'JSON array of available credit-pack purchases (id, label, credits, priceInr).',
    usedBy: 'controllers/aiQuota.controller.ts',
  },
  {
    key: 'EMAIL_AI_REWRITE',
    category: 'ai',
    isSecret: false,
    description: '"true" to let AI rewrite system emails (cold-start lobby tone). Disable to use raw templates.',
    defaultValue: 'false',
    usedBy: 'services/email/emailComposer.service.ts',
  },
  {
    key: 'NOTIFICATION_AI_REWRITE',
    category: 'ai',
    isSecret: false,
    description: '"true" to let AI rewrite push notification copy for personalization.',
    defaultValue: 'false',
    usedBy: 'services/notifications/notificationCopy.service.ts',
  },

  // ── Cloudinary ──────────────────────────────────────────────────────
  {
    key: 'CLOUDINARY_CLOUD_NAME',
    category: 'cloudinary',
    isSecret: false,
    description: 'Cloudinary cloud name (Account Details → Cloud Name).',
    usedBy: 'config/cloudinary.ts',
  },
  {
    key: 'CLOUDINARY_API_KEY',
    category: 'cloudinary',
    isSecret: false,
    description: 'Cloudinary API key. Non-secret per Cloudinary convention (paired with api_secret).',
    usedBy: 'config/cloudinary.ts',
  },
  {
    key: 'CLOUDINARY_API_SECRET',
    category: 'cloudinary',
    isSecret: true,
    description: 'Cloudinary API secret — required for signed uploads and resume PDF delivery.',
    usedBy: 'config/cloudinary.ts',
  },

  // ── Razorpay (subscriptions) ────────────────────────────────────────
  // Same key names across test/live — the active runtime mode (test DB vs
  // live DB) decides which value is read. Put test keys (rzp_test_...) into
  // the test DB and live keys (rzp_live_...) into the live DB.
  {
    key: 'RAZORPAY_KEY_ID',
    category: 'payment',
    isSecret: false,
    description: 'Razorpay key_id. Test DB stores rzp_test_..., live DB stores rzp_live_... Sent to the client during checkout.',
    usedBy: 'services/razorpay.service.ts',
  },
  {
    key: 'RAZORPAY_KEY_SECRET',
    category: 'payment',
    isSecret: true,
    description: 'Razorpay key_secret. Test DB stores the test secret, live DB stores the live one.',
    usedBy: 'services/razorpay.service.ts',
  },
  {
    key: 'RAZORPAY_WEBHOOK_SECRET',
    category: 'payment',
    isSecret: true,
    description: 'Shared secret configured in the Razorpay dashboard webhook settings. Each DB stores its own (test/live).',
    usedBy: 'controllers/subscription.controller.ts',
  },

  // ── Email (Gmail SMTP) ──────────────────────────────────────────────
  {
    key: 'SMTP_USER',
    category: 'email',
    isSecret: false,
    description: 'Gmail address used as the "from" for system mail (verification, password reset).',
    usedBy: 'services/email/email.service.ts',
  },
  {
    key: 'SMTP_PASS',
    category: 'email',
    isSecret: true,
    description: 'Gmail app password (NOT your account password — generate at myaccount.google.com/apppasswords).',
    usedBy: 'services/email/email.service.ts',
  },

  // ── Firebase ────────────────────────────────────────────────────────
  {
    key: 'FIREBASE_PROJECT_ID',
    category: 'firebase',
    isSecret: false,
    description: 'Firebase project ID (Console → Project Settings).',
    usedBy: 'services/firebase/admin.service.ts',
  },
  {
    key: 'FIREBASE_SERVICE_ACCOUNT_JSON',
    category: 'firebase',
    isSecret: true,
    description: 'Full service-account JSON (single line). Preferred over the env-only path-based loader.',
    usedBy: 'services/firebase/admin.service.ts',
  },

  // ── Cron ────────────────────────────────────────────────────────────
  {
    key: 'CRON_ENABLED',
    category: 'cron',
    isSecret: false,
    description: '"true" to run scheduled jobs (job scraper, alert checker, auto-apply, etc.). Set to "false" on read replicas.',
    defaultValue: 'true',
    usedBy: 'jobs/*',
  },

  // ── MSG91 (SMS + WhatsApp OTPs) ─────────────────────────────────────
  {
    key: 'MSG91_AUTH_KEY',
    category: 'misc',
    isSecret: true,
    description: 'MSG91 dashboard → API → Auth Key.',
    usedBy: 'services/msg91/msg91.service.ts',
  },
  {
    key: 'MSG91_SMS_SENDER_ID',
    category: 'misc',
    isSecret: false,
    description: '6-char alphanumeric DLT-registered sender id for SMS.',
    usedBy: 'services/msg91/msg91.service.ts',
  },
  {
    key: 'MSG91_SMS_TEMPLATE_ID',
    category: 'misc',
    isSecret: false,
    description: 'DLT-approved template id used for OTP SMS.',
    usedBy: 'services/msg91/msg91.service.ts',
  },
  {
    key: 'MSG91_WHATSAPP_NAMESPACE',
    category: 'misc',
    isSecret: false,
    description: 'WhatsApp Business namespace UUID.',
    usedBy: 'services/msg91/msg91.service.ts',
  },
  {
    key: 'MSG91_WHATSAPP_NUMBER',
    category: 'misc',
    isSecret: false,
    description: 'WhatsApp Business phone number (with country code, no +).',
    usedBy: 'services/msg91/msg91.service.ts',
  },
  {
    key: 'MSG91_WHATSAPP_TEMPLATE',
    category: 'misc',
    isSecret: false,
    description: 'Approved WhatsApp template name used for OTP.',
    usedBy: 'services/msg91/msg91.service.ts',
  },

  // ── Rate limiting (newly-migrated) ──────────────────────────────────
  {
    key: 'RATE_LIMIT_WINDOW_MS',
    category: 'misc',
    isSecret: false,
    description: 'Window (ms) for the global rate limiter. Change takes effect on next server start.',
    defaultValue: '900000',
    usedBy: 'middleware/rateLimiter.ts',
  },
  {
    key: 'RATE_LIMIT_MAX_REQUESTS',
    category: 'misc',
    isSecret: false,
    description: 'Max requests per window per token/IP for the global limiter.',
    defaultValue: '600',
    usedBy: 'middleware/rateLimiter.ts',
  },
];

/** Lookup helper for the admin UI's "suggest from key name" flow. */
export const getRegistryEntry = (key: string): ConfigRegistryEntry | undefined =>
  CONFIG_REGISTRY.find((e) => e.key === key);
