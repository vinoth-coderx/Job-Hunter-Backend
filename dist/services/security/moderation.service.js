"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.moderateJob = exports.findDuplicate = exports.contentHash = exports.runHeuristics = void 0;
const crypto_1 = __importDefault(require("crypto"));
const Job_1 = require("../../models/Job");
const JobModeration_1 = require("../../models/JobModeration");
const HirerProfile_1 = require("../../models/HirerProfile");
const providers_1 = require("../ai/providers");
const logger_1 = require("../../utils/logger");
const audit_service_1 = require("./audit.service");
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
const runHeuristics = (job) => {
    const text = [
        job.title,
        job.description,
        ...(job.responsibilities ?? []),
    ]
        .join(' \n ')
        .toLowerCase();
    const flags = new Set();
    const matched = [];
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
    if (job.salaryMax && job.salaryMax > 50_00_000) {
        flags.add('fake_salary');
        score += 20;
    }
    if (text.includes('mlm') || text.includes('downline') || text.includes('pyramid')) {
        flags.add('mlm_pattern');
        score += 25;
    }
    return { flags: Array.from(flags), matchedTerms: matched.slice(0, 10), score: Math.min(score, 100) };
};
exports.runHeuristics = runHeuristics;
const contentHash = (job) => {
    const normalized = `${job.title}\n${job.company}\n${job.description}`
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    return crypto_1.default.createHash('sha256').update(normalized).digest('hex');
};
exports.contentHash = contentHash;
const findDuplicate = async (job) => {
    const hash = (0, exports.contentHash)(job);
    const dup = await Job_1.Job.findOne({
        _id: { $ne: job._id },
        'moderation.contentHash': hash,
    });
    return dup;
};
exports.findDuplicate = findDuplicate;
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
const callRiskModel = async (job, preferred, system, modelTier) => {
    try {
        const result = await (0, providers_1.generate)({
            provider: preferred,
            tier: 'lite',
            system,
            user: `Job:\nTitle: ${job.title}\nCompany: ${job.company}\nDescription:\n${job.description.slice(0, 4000)}\n\nReturn {"score": number, "reasons": string[]}`,
            json: true,
            maxTokens: 300,
            temperature: 0.1,
        }, { feature: 'job_moderation' });
        const parsed = JSON.parse(result.text);
        const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
        const reasons = Array.isArray(parsed.reasons)
            ? parsed.reasons.map((r) => String(r)).slice(0, 3)
            : [];
        return { score, reasoning: reasons.join('; '), extraFlags: [], modelTier };
    }
    catch (e) {
        logger_1.logger.warn(`[moderation:${modelTier}] AI scoring failed: ${e.message}`);
        return null;
    }
};
const runAiRisk = async (job) => {
    if (!(0, providers_1.isAiEnabled)())
        return null;
    const groqAvailable = (0, providers_1.isProviderEnabled)('groq');
    const geminiAvailable = (0, providers_1.isProviderEnabled)('gemini') || (0, providers_1.isProviderEnabled)('claude');
    if (!groqAvailable) {
        return callRiskModel(job, undefined, SYSTEM_TRIAGE, 'gemini-only');
    }
    const triage = await callRiskModel(job, 'groq', SYSTEM_TRIAGE, 'groq-triage');
    if (!triage) {
        if (geminiAvailable) {
            return callRiskModel(job, undefined, SYSTEM_DEEP, 'gemini-fallback');
        }
        return null;
    }
    if (triage.score < 40 || !geminiAvailable) {
        return triage;
    }
    const deep = await callRiskModel(job, undefined, SYSTEM_DEEP, 'gemini-deep');
    if (!deep)
        return triage;
    return {
        score: Math.max(triage.score, deep.score),
        reasoning: deep.reasoning,
        extraFlags: [],
        modelTier: 'cascade:groq+gemini',
    };
};
const moderateJob = async (job) => {
    const heur = (0, exports.runHeuristics)(job);
    const hash = (0, exports.contentHash)(job);
    const flags = new Set(heur.flags);
    let recruiterTrust = 50;
    let recruiterUnverified = true;
    if (job.hirerProfile) {
        const hp = await HirerProfile_1.HirerProfile.findById(job.hirerProfile).select('trustScore verification.isVerified approvalStatus');
        if (hp) {
            recruiterTrust = hp.trustScore ?? 30;
            recruiterUnverified = !hp.verification?.isVerified;
            if (recruiterTrust < 30)
                flags.add('low_recruiter_trust');
            if (recruiterUnverified)
                flags.add('missing_company_verification');
        }
    }
    const dup = await (0, exports.findDuplicate)({ ...job.toObject(), _id: job._id });
    if (dup) {
        flags.add('duplicate_content');
    }
    const ai = await runAiRisk(job);
    const aiScore = ai?.score ?? 0;
    const trustPenalty = recruiterUnverified ? 10 : 0;
    const blended = Math.min(100, Math.round(heur.score * 0.6 + aiScore * 0.3 + trustPenalty + (recruiterTrust < 30 ? 10 : 0)));
    let decision;
    if (blended >= 75)
        decision = 'auto_rejected';
    else if (blended >= 35 || flags.has('asks_payment') || flags.has('mlm_pattern') || dup)
        decision = 'queued';
    else if (recruiterUnverified)
        decision = 'queued';
    else
        decision = 'auto_approved';
    await JobModeration_1.JobModeration.create({
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
    await (0, audit_service_1.writeAudit)({
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
exports.moderateJob = moderateJob;
