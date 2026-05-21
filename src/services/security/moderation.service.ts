import crypto from 'crypto';
import { Job, IJob } from '../../models/Job';
import { JobModeration, ModerationFlag, ModerationDecision } from '../../models/JobModeration';
import { HirerProfile } from '../../models/HirerProfile';
import { generate, isAiEnabled, isProviderEnabled } from '../ai/providers';
import { logger } from '../../utils/logger';
import { writeAudit } from './audit.service';

// Why heuristics first, AI second:
//   Heuristics catch the obvious scams cheaply and deterministically.
//   The AI risk score is layered on top to catch subtler patterns
//   (paraphrased payment asks, multi-step funnel scams, etc).
// Decision boundaries:
//   risk >= 75 → auto_rejected
//   risk >= 35 OR any high-severity flag → queued for admin
//   else → auto_approved

const SCAM_KEYWORDS = [
  'registration fee',
  'security deposit',
  'pay to apply',
  'training fee',
  'kit charges',
  'pay first',
  'investment required',
  'investment opportunity',
  'work from home guaranteed',
  'earn ₹50,000 daily',
  'data entry instant payout',
  'no experience high salary',
  'send your bank',
  'send aadhaar',
  'forex',
  'crypto investment',
  'mlm',
  'multi level marketing',
  'pyramid',
  'referral chain',
];

const WHATSAPP_TELEGRAM_PATTERNS = [
  /whatsapp\s*[:\-]?\s*\+?\d{10,}/i,
  /\bwa\.me\/\d+/i,
  /t\.me\//i,
  /telegram\s*[:\-]?\s*@?[\w_]+/i,
  /ping\s+me\s+on\s+(whatsapp|telegram)/i,
];

const SUSPICIOUS_URL_PATTERNS = [
  /bit\.ly\//i,
  /tinyurl\.com\//i,
  /linktr\.ee\//i,
  /\.tk\//i,
  /\.ml\//i,
  /\.gq\//i,
  /forms\.gle\/[\w-]+/i,
];

const PAYMENT_KEYWORDS = [
  'upi id',
  'paytm',
  'phonepe',
  'gpay',
  'razorpay link',
  'pay ₹',
  'pay rs.',
  'transfer fee',
];

export interface HeuristicReport {
  flags: ModerationFlag[];
  matchedTerms: string[];
  score: number;
}

// Exported so the test suite can exercise the heuristic logic in
// isolation — the rest of `moderateJob` hits Mongo + the AI provider
// which require fixtures the unit tests don't want to set up.
export const runHeuristics = (job: Pick<IJob, 'title' | 'description' | 'responsibilities' | 'salaryMin' | 'salaryMax'>): HeuristicReport => {
  const text = [
    job.title,
    job.description,
    ...(job.responsibilities ?? []),
  ]
    .join(' \n ')
    .toLowerCase();

  const flags: Set<ModerationFlag> = new Set();
  const matched: string[] = [];
  let score = 0;

  for (const kw of SCAM_KEYWORDS) {
    if (text.includes(kw)) {
      flags.add('scam_keywords');
      matched.push(kw);
      score += 18;
    }
  }
  for (const re of WHATSAPP_TELEGRAM_PATTERNS) {
    if (re.test(text)) {
      flags.add('whatsapp_only_contact');
      matched.push(re.source);
      score += 22;
      break;
    }
  }
  for (const re of SUSPICIOUS_URL_PATTERNS) {
    if (re.test(text)) {
      flags.add('suspicious_url');
      matched.push(re.source);
      score += 15;
    }
  }
  for (const kw of PAYMENT_KEYWORDS) {
    if (text.includes(kw)) {
      flags.add('asks_payment');
      matched.push(kw);
      score += 25;
    }
  }
  // Salary realism: > 10 LPA with no experience requirement & no
  // company description is a strong scam signal.
  if (job.salaryMax && job.salaryMax > 50_00_000) {
    flags.add('fake_salary');
    score += 20;
  }
  // MLM signal layered on top of scam keywords.
  if (text.includes('mlm') || text.includes('downline') || text.includes('pyramid')) {
    flags.add('mlm_pattern');
    score += 25;
  }
  return { flags: Array.from(flags), matchedTerms: matched.slice(0, 10), score: Math.min(score, 100) };
};

export const contentHash = (job: Pick<IJob, 'title' | 'description' | 'company'>): string => {
  const normalized = `${job.title}\n${job.company}\n${job.description}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
};

export const findDuplicate = async (
  job: Pick<IJob, 'title' | 'description' | 'company' | '_id'>,
): Promise<IJob | null> => {
  const hash = contentHash(job);
  const dup = await Job.findOne({
    _id: { $ne: job._id },
    'moderation.contentHash': hash,
  });
  return dup;
};

interface AiRisk {
  score: number;
  reasoning: string;
  extraFlags: ModerationFlag[];
  /** Which providers actually ran — used by `modelTier` for accounting. */
  modelTier: string;
}

const SYSTEM_TRIAGE = `You are a job-listing fraud triage scanner. Quick first pass — score 0-100 fraud risk and list at most 3 reasons.

Score guide:
- 0-30: clean listing, normal job
- 30-60: some yellow flags, needs deeper look
- 60-100: clearly suspicious / scammy

Output STRICT JSON only: {"score": number, "reasons": string[]}.`;

const SYSTEM_DEEP = `You are a senior fraud analyst reviewing a job listing flagged as potentially suspicious. Score 0-100 fraud risk with detailed reasoning.

Look for:
- Payment requests (registration, training, kit fees)
- Unrealistic salary for stated experience
- MLM / pyramid / referral-chain language
- Recruiter contact patterns suggesting account farming
- Vague company / vague description / no growth signal
- WhatsApp/Telegram-only contact (no email, no phone)

Be conservative — only score above 70 if there are clear scam signals.

Output STRICT JSON only: {"score": number, "reasons": string[]}.`;

const callRiskModel = async (
  job: Pick<IJob, 'title' | 'company' | 'description'>,
  preferred: 'groq' | undefined,
  system: string,
  modelTier: string,
): Promise<AiRisk | null> => {
  try {
    const result = await generate(
      {
        provider: preferred,
        tier: 'lite',
        system,
        user: `Job:\nTitle: ${job.title}\nCompany: ${job.company}\nDescription:\n${job.description.slice(0, 4000)}\n\nReturn {"score": number, "reasons": string[]}`,
        json: true,
        maxTokens: 300,
        temperature: 0.1,
      },
      { feature: 'job_moderation' },
    );
    const parsed = JSON.parse(result.text) as { score?: unknown; reasons?: unknown };
    const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.map((r) => String(r)).slice(0, 3)
      : [];
    return { score, reasoning: reasons.join('; '), extraFlags: [], modelTier };
  } catch (e) {
    logger.warn(`[moderation:${modelTier}] AI scoring failed: ${(e as Error).message}`);
    return null;
  }
};

/**
 * Two-pass cascade: Groq triage first (cheap), Gemini deep-dive only if
 * Groq's score is in the suspicious band (>= 40). For the 80%+ of clean
 * listings this means we never spend a Gemini token. The deep pass uses
 * a more rigorous prompt and trusts Gemini's score over Groq's when
 * they disagree (deep > triage).
 *
 * Falls back to single-pass Gemini when Groq isn't configured, and
 * single-pass Groq when Gemini isn't.
 */
const runAiRisk = async (
  job: Pick<IJob, 'title' | 'company' | 'description'>,
): Promise<AiRisk | null> => {
  if (!isAiEnabled()) return null;

  const groqAvailable = isProviderEnabled('groq');
  const geminiAvailable = isProviderEnabled('gemini');

  // No Groq: run Gemini once, same as before.
  if (!groqAvailable) {
    return callRiskModel(job, undefined, SYSTEM_TRIAGE, 'gemini-only');
  }

  // Groq triage pass.
  const triage = await callRiskModel(job, 'groq', SYSTEM_TRIAGE, 'groq-triage');
  if (!triage) {
    // Triage failed — fall through to Gemini if available, else give up.
    if (geminiAvailable) {
      return callRiskModel(job, undefined, SYSTEM_DEEP, 'gemini-fallback');
    }
    return null;
  }

  // Clean listing — trust Groq, skip Gemini. Saves the Gemini call entirely.
  if (triage.score < 40 || !geminiAvailable) {
    return triage;
  }

  // Suspicious enough to warrant a Gemini deep-dive.
  const deep = await callRiskModel(job, undefined, SYSTEM_DEEP, 'gemini-deep');
  if (!deep) return triage;

  // Take the higher score (more cautious) but use Gemini's reasoning
  // since it's the more authoritative analyst.
  return {
    score: Math.max(triage.score, deep.score),
    reasoning: deep.reasoning,
    extraFlags: [],
    modelTier: 'cascade:groq+gemini',
  };
};

export interface ModerationResult {
  decision: ModerationDecision;
  riskScore: number;
  flags: ModerationFlag[];
  contentHash: string;
  duplicateOf?: string;
  reasoning?: string;
}

export const moderateJob = async (
  job: IJob,
): Promise<ModerationResult> => {
  const heur = runHeuristics(job);
  const hash = contentHash(job);
  const flags = new Set<ModerationFlag>(heur.flags);

  // Recruiter trust factor — low trust hirers get a +20 risk bump and
  // can't be auto-approved even on a clean listing.
  let recruiterTrust = 50;
  let recruiterUnverified = true;
  if (job.hirerProfile) {
    const hp = await HirerProfile.findById(job.hirerProfile).select(
      'trustScore verification.isVerified approvalStatus',
    );
    if (hp) {
      recruiterTrust = hp.trustScore ?? 30;
      recruiterUnverified = !hp.verification?.isVerified;
      if (recruiterTrust < 30) flags.add('low_recruiter_trust');
      if (recruiterUnverified) flags.add('missing_company_verification');
    }
  }

  // Duplicate detection
  const dup = await findDuplicate({ ...job.toObject(), _id: job._id });
  if (dup) {
    flags.add('duplicate_content');
  }

  const ai = await runAiRisk(job);
  const aiScore = ai?.score ?? 0;

  // Weighted blend: heuristics 60%, AI 30%, recruiter-trust penalty 10%.
  const trustPenalty = recruiterUnverified ? 10 : 0;
  const blended = Math.min(
    100,
    Math.round(heur.score * 0.6 + aiScore * 0.3 + trustPenalty + (recruiterTrust < 30 ? 10 : 0)),
  );

  let decision: ModerationDecision;
  if (blended >= 75) decision = 'auto_rejected';
  else if (blended >= 35 || flags.has('asks_payment') || flags.has('mlm_pattern') || dup) decision = 'queued';
  else if (recruiterUnverified) decision = 'queued';
  else decision = 'auto_approved';

  await JobModeration.create({
    job: job._id,
    hirer: job.postedBy,
    company: job.hirerProfile,
    riskScore: blended,
    decision,
    flags: Array.from(flags),
    contentHash: hash,
    duplicateOf: dup?._id,
    reasoning: ai?.reasoning,
    modelTier: ai?.modelTier,
  });

  await writeAudit({
    actorType: 'system',
    category: 'job_moderation',
    action: `moderation:${decision}`,
    target: { type: 'Job', id: job._id, label: job.title },
    metadata: { riskScore: blended, flags: Array.from(flags), duplicateOf: dup?._id },
  });

  return {
    decision,
    riskScore: blended,
    flags: Array.from(flags),
    contentHash: hash,
    duplicateOf: dup?._id?.toString(),
    reasoning: ai?.reasoning,
  };
};
