"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiJobSearch = exports.extractSearchIntent = void 0;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../../config/env");
const constants_1 = require("../../config/constants");
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const Job_1 = require("../../models/Job");
const client = env_1.env.ANTHROPIC_API_KEY
    ? new sdk_1.default({ apiKey: env_1.env.ANTHROPIC_API_KEY })
    : null;
const MODEL = 'claude-haiku-4-5-20251001';
const normaliseQueryForCache = (q) => q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const cacheKeyForIntent = (q) => `jobsearch:intent:${crypto_1.default
    .createHash('sha1')
    .update(normaliseQueryForCache(q))
    .digest('hex')}`;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanList = (xs) => Array.isArray(xs)
    ? xs
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter((x) => x.length >= 2 && x.length <= 60)
        .slice(0, 8)
    : [];
const cleanString = (s, max = 80) => {
    if (typeof s !== 'string')
        return undefined;
    const t = s.trim();
    return t.length >= 2 && t.length <= max ? t : undefined;
};
const cleanNumber = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
        return undefined;
    return n;
};
const cleanEnum = (s, allowed) => {
    if (typeof s !== 'string')
        return undefined;
    const v = s.trim().toLowerCase();
    return allowed.includes(v) ? v : undefined;
};
const REMOTE = ['remote', 'hybrid', 'onsite'];
const JOB_TYPE = [
    'full-time',
    'part-time',
    'contract',
    'internship',
    'temporary',
];
const heuristicIntent = (query) => {
    const lc = query.toLowerCase();
    const tokens = lc
        .split(/[\s,/+&|]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2);
    const remote = REMOTE.find((r) => lc.includes(r));
    const jobType = lc.includes('full time') || lc.includes('full-time') ? 'full-time'
        : lc.includes('part time') || lc.includes('part-time') ? 'part-time'
            : lc.includes('intern') ? 'internship'
                : lc.includes('contract') || lc.includes('freelance') ? 'contract'
                    : undefined;
    return {
        titleKeywords: tokens.slice(0, 5),
        skills: [],
        roleKeywords: tokens.slice(0, 5),
        companyKeywords: [],
        remoteType: remote,
        jobType,
        freeText: query,
    };
};
const extractSearchIntent = async (query) => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
        return {
            titleKeywords: [],
            skills: [],
            roleKeywords: [],
            companyKeywords: [],
        };
    }
    const cached = await redis_1.redis.get(cacheKeyForIntent(trimmed));
    if (cached) {
        try {
            return JSON.parse(cached);
        }
        catch {
        }
    }
    if (!client) {
        const intent = heuristicIntent(trimmed);
        await redis_1.redis.setex(cacheKeyForIntent(trimmed), 86400, JSON.stringify(intent));
        return intent;
    }
    try {
        const response = await client.beta.messages.create({
            model: MODEL,
            max_tokens: 500,
            system: [
                {
                    type: 'text',
                    text: 'You parse a job seeker\'s natural-language query into structured filters. Identify role/title keywords, skills, target companies, location, job type, remote preference, experience range, and salary expectation. Return strict JSON only — no prose, no markdown.',
                    cache_control: { type: 'ephemeral' },
                },
            ],
            messages: [
                {
                    role: 'user',
                    content: `Parse this job search query into structured filters.

Query: "${trimmed}"

Return JSON with this exact shape (omit fields that aren't in the query):
{
  "titleKeywords": ["e.g. senior, flutter, developer"],
  "skills": ["e.g. flutter, dart, firebase"],
  "roleKeywords": ["e.g. frontend developer, backend engineer"],
  "companyKeywords": ["e.g. google, faang"],
  "location": "city or region (string)",
  "jobType": "full-time | part-time | contract | internship | temporary",
  "remoteType": "remote | hybrid | onsite",
  "experienceMinYears": <number>,
  "experienceMaxYears": <number>,
  "salaryMinLpa": <number, in INR lakhs per annum>,
  "freeText": "the original query verbatim"
}

Examples:
- "senior react dev in bangalore" → titleKeywords=["senior","react","developer"], skills=["react"], roleKeywords=["frontend developer"], location="bangalore"
- "remote flutter jobs 15 LPA" → skills=["flutter"], remoteType="remote", salaryMinLpa=15
- "full time data scientist with python at faang" → titleKeywords=["data","scientist"], skills=["python"], jobType="full-time", companyKeywords=["google","meta","amazon","apple","netflix"]`,
                },
            ],
        });
        const text = response.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
        const jsonStr = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const parsed = JSON.parse(jsonStr);
        const intent = {
            titleKeywords: cleanList(parsed.titleKeywords),
            skills: cleanList(parsed.skills),
            roleKeywords: cleanList(parsed.roleKeywords),
            companyKeywords: cleanList(parsed.companyKeywords),
            location: cleanString(parsed.location),
            jobType: cleanEnum(parsed.jobType, JOB_TYPE),
            remoteType: cleanEnum(parsed.remoteType, REMOTE),
            experienceMinYears: cleanNumber(parsed.experienceMinYears),
            experienceMaxYears: cleanNumber(parsed.experienceMaxYears),
            salaryMinLpa: cleanNumber(parsed.salaryMinLpa),
            freeText: trimmed,
        };
        await redis_1.redis.setex(cacheKeyForIntent(trimmed), 86400, JSON.stringify(intent));
        return intent;
    }
    catch (err) {
        logger_1.logger.warn(`jobSearch LLM intent failed: ${err.message}`);
        const intent = heuristicIntent(trimmed);
        await redis_1.redis.setex(cacheKeyForIntent(trimmed), 86400, JSON.stringify(intent));
        return intent;
    }
};
exports.extractSearchIntent = extractSearchIntent;
const SEARCH_FRESHNESS_DAYS = Math.max(constants_1.JOB_FRESHNESS_DAYS, 60);
const buildMongoFilter = (intent, excludeJobIds, opts = {}) => {
    const cutoff = new Date(Date.now() - SEARCH_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
    const filter = {};
    if (!opts.dropActive)
        filter.isActive = true;
    if (!opts.dropFreshness)
        filter.postedAt = { $gte: cutoff };
    if (excludeJobIds.length > 0) {
        filter._id = { $nin: excludeJobIds };
    }
    const orClauses = [];
    for (const kw of intent.titleKeywords) {
        const re = new RegExp(escapeRegex(kw), 'i');
        orClauses.push({ title: re });
        orClauses.push({ description: re });
    }
    for (const sk of intent.skills) {
        const re = new RegExp(escapeRegex(sk), 'i');
        orClauses.push({ skills: re });
        orClauses.push({ description: re });
        orClauses.push({ title: re });
    }
    for (const role of intent.roleKeywords) {
        const re = new RegExp(escapeRegex(role), 'i');
        orClauses.push({ title: re });
        orClauses.push({ department: re });
        orClauses.push({ responsibilities: re });
    }
    for (const co of intent.companyKeywords) {
        const re = new RegExp(escapeRegex(co), 'i');
        orClauses.push({ company: re });
    }
    if (orClauses.length > 0) {
        filter.$or = orClauses;
    }
    else if (intent.freeText && intent.freeText.length > 0) {
        filter.$text = { $search: intent.freeText };
    }
    if (intent.location) {
        filter.location = { $regex: escapeRegex(intent.location), $options: 'i' };
    }
    if (intent.jobType)
        filter.jobType = intent.jobType;
    if (intent.remoteType)
        filter.remoteType = intent.remoteType;
    if (typeof intent.salaryMinLpa === 'number') {
        filter.salaryMin = { $gte: intent.salaryMinLpa * 100000 };
    }
    if (typeof intent.experienceMinYears === 'number') {
        filter.$and = [
            ...(filter.$and ?? []),
            {
                $or: [
                    { experienceMaxYears: { $gte: intent.experienceMinYears } },
                    { experienceMaxYears: { $exists: false } },
                ],
            },
        ];
    }
    return filter;
};
const scoreJob = (job, intent) => {
    const title = job.title.toLowerCase();
    const desc = job.description.toLowerCase();
    const dept = (job.department || '').toLowerCase();
    const company = job.company.toLowerCase();
    const loc = job.location.toLowerCase();
    const skillBag = (job.skills || []).map((s) => s.toLowerCase());
    const respBag = (job.responsibilities || []).map((r) => r.toLowerCase());
    let s = 0;
    for (const t of intent.titleKeywords) {
        const lt = t.toLowerCase();
        if (title.includes(lt))
            s += 4;
        if (desc.includes(lt))
            s += 1;
    }
    for (const sk of intent.skills) {
        const lsk = sk.toLowerCase();
        if (skillBag.some((b) => b.includes(lsk)))
            s += 3;
        if (title.includes(lsk))
            s += 2;
        if (desc.includes(lsk))
            s += 1;
    }
    for (const role of intent.roleKeywords) {
        const lr = role.toLowerCase();
        if (title.includes(lr))
            s += 3;
        if (dept.includes(lr))
            s += 2;
        if (respBag.some((b) => b.includes(lr)))
            s += 2;
    }
    for (const co of intent.companyKeywords) {
        if (company.includes(co.toLowerCase()))
            s += 4;
    }
    if (intent.location && loc.includes(intent.location.toLowerCase()))
        s += 2;
    const ageDays = (Date.now() - new Date(job.postedAt).getTime()) / (1000 * 60 * 60 * 24);
    s += Math.max(0, (7 - Math.min(ageDays, 7)) / 7);
    return s;
};
const fetchAndRank = async (filter, intent, limit) => {
    const candidatePool = Math.max(limit * 4, 60);
    const candidates = await Job_1.Job.find(filter)
        .sort({ postedAt: -1 })
        .limit(candidatePool)
        .lean();
    return candidates
        .map((j) => ({ job: j, score: scoreJob(j, intent) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => r.job);
};
const aiJobSearch = async ({ query, limit = 30, excludeJobIds = [], }) => {
    const intent = await (0, exports.extractSearchIntent)(query);
    const primary = await fetchAndRank(buildMongoFilter(intent, excludeJobIds), intent, limit);
    if (primary.length > 0) {
        logger_1.logger.info(`aiJobSearch: "${query.slice(0, 60)}" → ${primary.length} (primary)`);
        return { intent, jobs: primary, total: primary.length, scope: 'primary' };
    }
    const extended = await fetchAndRank(buildMongoFilter(intent, excludeJobIds, { dropFreshness: true }), intent, limit);
    if (extended.length > 0) {
        logger_1.logger.info(`aiJobSearch: "${query.slice(0, 60)}" → ${extended.length} (extended, freshness dropped)`);
        return {
            intent,
            jobs: extended,
            total: extended.length,
            scope: 'extended',
        };
    }
    const archived = await fetchAndRank(buildMongoFilter(intent, excludeJobIds, {
        dropFreshness: true,
        dropActive: true,
    }), intent, limit);
    if (archived.length > 0) {
        logger_1.logger.info(`aiJobSearch: "${query.slice(0, 60)}" → ${archived.length} (archived, all gates dropped)`);
        return {
            intent,
            jobs: archived,
            total: archived.length,
            scope: 'archived',
        };
    }
    logger_1.logger.info(`aiJobSearch: "${query.slice(0, 60)}" → 0 (intent=${JSON.stringify({
        titles: intent.titleKeywords,
        skills: intent.skills,
        roles: intent.roleKeywords,
    })})`);
    return { intent, jobs: [], total: 0, scope: 'empty' };
};
exports.aiJobSearch = aiJobSearch;
