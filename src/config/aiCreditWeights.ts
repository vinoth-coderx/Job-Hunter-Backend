import { getAppConfig } from '../services/config/config.service';

/**
 * Per-feature credit weights. Charged against the same daily quota
 * counter (`AI_QUOTA_PER_USER_PER_DAY`), but heavier features cost more
 * slots so users can't burn through the cap on cheap features and then
 * be unable to use the expensive ones.
 *
 * Defaults below; admin overrides via AppConfig key
 * `AI_CREDIT_WEIGHTS_JSON` (JSON object string). Unknown features fall
 * back to weight 1, matching the historical uniform behaviour.
 *
 * Tuning rationale:
 *   - 0   → free system calls (moderation triage, query expansion,
 *           notification copy, query expand) — already cached or free-tier
 *   - 1   → light user calls (chat, single-field suggest, rewrite)
 *   - 2   → moderate (cover letter, profile optimizer, skill gap)
 *   - 3   → heavy smart-tier (ATS score, job insight, resume onboarding)
 *   - 5   → batch + smart-tier (applicant ranking — one call covers many)
 */
const DEFAULT_WEIGHTS: Record<string, number> = {
  // Seeker, light
  chat: 1,
  field_suggest: 1,
  for_you: 1,
  'resume_rewrite:bullet': 1,
  'resume_rewrite:summary': 1,
  'resume_rewrite:achievement': 1,
  // Seeker, moderate
  cover_letter: 2,
  profile_optimizer: 2,
  skill_gap: 2,
  // Seeker, heavy (smart-tier reasoning)
  ats_score: 3,
  job_insight: 3,
  resume_onboarding: 3,
  // One smart-tier call per template download that AI-fills the
  // seeker's profile into rich resume copy. Bundled with the template
  // download quota credit (admin can split via AppConfig).
  resume_template_fill: 3,
  // Hirer
  jd_generator: 2,
  jd_polish: 1,
  screening_questions: 1,
  applicant_rank: 5,
  candidate_suggest: 5,
  recruiter_outreach: 1,
  hirer_digest: 1,
  resume_tldr: 1,
  chat_smart_reply: 0,
  company_description: 1,
  // System / cached / cheap-Groq lane — never charged to the user
  query_expand: 0,
  notification_copy: 0,
  email_subject: 0,
  job_moderation: 0,
  skill_extract: 0,
  alert_name: 0,
};

let cachedOverrides: Record<string, number> | null = null;
let cachedRaw: string | null = null;

const overridesFromAppConfig = (): Record<string, number> => {
  const raw = getAppConfig('AI_CREDIT_WEIGHTS_JSON');
  if (!raw) {
    cachedOverrides = null;
    cachedRaw = null;
    return {};
  }
  if (cachedOverrides && cachedRaw === raw) return cachedOverrides;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      cachedOverrides = {};
      cachedRaw = raw;
      return {};
    }
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 50) {
        out[k] = Math.round(v);
      }
    }
    cachedOverrides = out;
    cachedRaw = raw;
    return out;
  } catch {
    cachedOverrides = {};
    cachedRaw = raw;
    return {};
  }
};

/**
 * Resolves the weight for a feature. Falls back to 1 for unknown
 * features (legacy callers that haven't been mapped yet).
 */
export const getCreditWeight = (feature: string): number => {
  const overrides = overridesFromAppConfig();
  if (feature in overrides) return overrides[feature];
  if (feature in DEFAULT_WEIGHTS) return DEFAULT_WEIGHTS[feature];
  return 1;
};

export const getDefaultWeights = (): Readonly<Record<string, number>> =>
  DEFAULT_WEIGHTS;

/** Read-only snapshot of the active overrides (admin UI). */
export const getCurrentOverrides = (): Readonly<Record<string, number>> =>
  overridesFromAppConfig();

/**
 * Validate + serialise an overrides map for persistence in
 * `AI_CREDIT_WEIGHTS_JSON`. Returns the JSON string ready for
 * `setAppConfig`. Caller is responsible for the actual write — this
 * stays pure so unit tests can validate without hitting Mongo.
 */
export const serializeOverridesForConfig = (
  next: Record<string, unknown>,
): string => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(next ?? {})) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 60) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 50) {
      continue;
    }
    out[k] = Math.round(v);
  }
  return JSON.stringify(out);
};
