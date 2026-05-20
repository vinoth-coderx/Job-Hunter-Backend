"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeOverridesForConfig = exports.getCurrentOverrides = exports.getDefaultWeights = exports.getCreditWeight = void 0;
const config_service_1 = require("../services/config/config.service");
const DEFAULT_WEIGHTS = {
    chat: 1,
    field_suggest: 1,
    for_you: 1,
    'resume_rewrite:bullet': 1,
    'resume_rewrite:summary': 1,
    'resume_rewrite:achievement': 1,
    cover_letter: 2,
    profile_optimizer: 2,
    skill_gap: 2,
    ats_score: 3,
    job_insight: 3,
    resume_onboarding: 3,
    resume_template_fill: 3,
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
    query_expand: 0,
    notification_copy: 0,
    email_subject: 0,
    job_moderation: 0,
    skill_extract: 0,
    alert_name: 0,
};
let cachedOverrides = null;
let cachedRaw = null;
const overridesFromAppConfig = () => {
    const raw = (0, config_service_1.getAppConfig)('AI_CREDIT_WEIGHTS_JSON');
    if (!raw) {
        cachedOverrides = null;
        cachedRaw = null;
        return {};
    }
    if (cachedOverrides && cachedRaw === raw)
        return cachedOverrides;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            cachedOverrides = {};
            cachedRaw = raw;
            return {};
        }
        const out = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 50) {
                out[k] = Math.round(v);
            }
        }
        cachedOverrides = out;
        cachedRaw = raw;
        return out;
    }
    catch {
        cachedOverrides = {};
        cachedRaw = raw;
        return {};
    }
};
const getCreditWeight = (feature) => {
    const overrides = overridesFromAppConfig();
    if (feature in overrides)
        return overrides[feature];
    if (feature in DEFAULT_WEIGHTS)
        return DEFAULT_WEIGHTS[feature];
    return 1;
};
exports.getCreditWeight = getCreditWeight;
const getDefaultWeights = () => DEFAULT_WEIGHTS;
exports.getDefaultWeights = getDefaultWeights;
const getCurrentOverrides = () => overridesFromAppConfig();
exports.getCurrentOverrides = getCurrentOverrides;
const serializeOverridesForConfig = (next) => {
    const out = {};
    for (const [k, v] of Object.entries(next ?? {})) {
        if (typeof k !== 'string' || k.length === 0 || k.length > 60)
            continue;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 50) {
            continue;
        }
        out[k] = Math.round(v);
    }
    return JSON.stringify(out);
};
exports.serializeOverridesForConfig = serializeOverridesForConfig;
