"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiJobSearch = exports.extractSearchIntent = void 0;
const crypto_1 = __importDefault(require("crypto"));
const constants_1 = require("../../config/constants");
const logger_1 = require("../../utils/logger");
const redis_1 = require("../../config/redis");
const Job_1 = require("../../models/Job");
const providers_1 = require("./providers");
const jobFeed_service_1 = require("../jobFeed.service");
const queryExpander_service_1 = require("./queryExpander.service");
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
    if (!(0, providers_1.isAiEnabled)()) {
        const intent = heuristicIntent(trimmed);
        await redis_1.redis.setex(cacheKeyForIntent(trimmed), 86400, JSON.stringify(intent));
        return intent;
    }
    try {
        const parsed = await (0, providers_1.generateJson)({
            tier: 'lite',
            system: "You parse a job seeker's natural-language query into structured filters. Identify role/title keywords, skills, target companies, location, job type, remote preference, experience range, and salary expectation. Return strict JSON only — no prose, no markdown.",
            user: `Parse this job search query into structured filters.

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
            maxTokens: 500,
            temperature: 0.2,
        });
        if (!parsed)
            throw new Error('No JSON in response');
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
        if (err instanceof providers_1.AiProviderQuotaError) {
            logger_1.logger.warn(`jobSearch LLM intent QUOTA EXCEEDED — falling back to heuristic for "${trimmed.slice(0, 80)}"`);
            const intent = heuristicIntent(trimmed);
            await redis_1.redis.setex(cacheKeyForIntent(trimmed), 3600, JSON.stringify(intent));
            return intent;
        }
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
    const filter = { isNative: true };
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
const STOPWORDS = new Set([
    'a',
    'an',
    'and',
    'at',
    'by',
    'for',
    'from',
    'in',
    'of',
    'on',
    'or',
    'the',
    'to',
    'with',
    'job',
    'jobs',
    'role',
    'roles',
    'work',
]);
const matchesRawQuery = (job, rawQuery) => {
    const tokens = rawQuery
        .toLowerCase()
        .split(/[\s,/+&|()\-]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    if (tokens.length === 0)
        return true;
    const haystack = [
        job.title,
        (job.skills || []).join(' '),
        (job.responsibilities || []).join(' '),
        job.department || '',
        job.description,
    ]
        .join(' ')
        .toLowerCase();
    return tokens.every((t) => haystack.includes(t));
};
const fetchNativeAndRank = async (filter, intent, limit) => {
    const candidatePool = Math.max(limit * 4, 60);
    const candidates = await Job_1.Job.find(filter)
        .sort({ postedAt: -1 })
        .limit(candidatePool)
        .lean();
    return candidates
        .map(jobFeed_service_1.toFeedJobFromNative)
        .map((j) => ({ job: j, score: scoreJob(j, intent) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => r.job);
};
const queriesFromIntent = (intent) => {
    const candidates = [
        ...intent.roleKeywords,
        ...intent.titleKeywords,
        ...intent.skills,
    ];
    const out = [];
    for (const c of candidates) {
        const v = c.trim();
        if (v.length === 0)
            continue;
        if (out.includes(v.toLowerCase()))
            continue;
        out.push(v.toLowerCase());
        if (out.length === 3)
            break;
    }
    if (out.length === 0 && intent.freeText)
        out.push(intent.freeText.trim());
    return out;
};
const fetchExternalAndRank = async (intent, applied, limit) => {
    const queries = queriesFromIntent(intent);
    if (queries.length === 0)
        return [];
    const locations = intent.location ? [intent.location] : [];
    const scraped = await (0, jobFeed_service_1.fetchExternalForProfile)(queries, locations);
    let feed = scraped.map(jobFeed_service_1.toFeedJobFromScraped);
    feed = (0, jobFeed_service_1.filterApplied)(feed, applied);
    if (intent.jobType)
        feed = feed.filter((j) => j.jobType === intent.jobType);
    if (intent.remoteType) {
        feed = feed.filter((j) => j.remoteType === intent.remoteType);
    }
    if (typeof intent.salaryMinLpa === 'number') {
        const minRupees = intent.salaryMinLpa * 100000;
        feed = feed.filter((j) => {
            const top = j.salaryMax ?? j.salaryMin;
            return top === undefined || top >= minRupees;
        });
    }
    return feed
        .map((j) => ({ job: j, score: scoreJob(j, intent) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => r.job);
};
const aiJobSearch = async ({ query, limit = 30, excludeApplied, }) => {
    const [intent, synonyms] = await Promise.all([
        (0, exports.extractSearchIntent)(query),
        (0, queryExpander_service_1.expandQuery)(query),
    ]);
    if (synonyms.length > 0) {
        const seen = new Set(intent.titleKeywords.map((s) => s.toLowerCase()));
        const seenSkills = new Set(intent.skills.map((s) => s.toLowerCase()));
        const titleAdds = [];
        const skillAdds = [];
        for (const s of synonyms) {
            const lc = s.toLowerCase();
            if (!lc.includes(' ') && lc.length <= 30 && !seenSkills.has(lc)) {
                skillAdds.push(s);
                seenSkills.add(lc);
            }
            else if (!seen.has(lc)) {
                titleAdds.push(s);
                seen.add(lc);
            }
        }
        intent.titleKeywords = [...intent.titleKeywords, ...titleAdds].slice(0, 12);
        intent.skills = [...intent.skills, ...skillAdds].slice(0, 12);
    }
    const applied = excludeApplied ?? {
        jobIds: new Set(),
        externalKeys: new Set(),
    };
    const excludeJobIds = Array.from(applied.jobIds);
    const externalPromise = fetchExternalAndRank(intent, applied, limit);
    const primary = await fetchNativeAndRank(buildMongoFilter(intent, excludeJobIds), intent, limit);
    let nativeJobs = primary;
    let scope = 'primary';
    if (nativeJobs.length === 0) {
        const extended = await fetchNativeAndRank(buildMongoFilter(intent, excludeJobIds, { dropFreshness: true }), intent, limit);
        if (extended.length > 0) {
            nativeJobs = extended;
            scope = 'extended';
        }
        else {
            const archived = await fetchNativeAndRank(buildMongoFilter(intent, excludeJobIds, {
                dropFreshness: true,
                dropActive: true,
            }), intent, limit);
            if (archived.length > 0) {
                nativeJobs = archived;
                scope = 'archived';
            }
        }
    }
    const externalJobs = await externalPromise;
    const candidates = [...nativeJobs, ...externalJobs].map((j) => ({
        job: j,
        score: scoreJob(j, intent),
        strict: matchesRawQuery(j, query),
    }));
    const strictTier = candidates
        .filter((r) => r.strict)
        .sort((a, b) => b.score - a.score);
    const relatedTier = candidates
        .filter((r) => !r.strict)
        .sort((a, b) => b.score - a.score);
    if (strictTier.length === 1) {
        strictTier[0].job = { ...strictTier[0].job, matchScore: 92 };
    }
    else if (strictTier.length > 1) {
        const last = strictTier.length - 1;
        strictTier.forEach((r, i) => {
            const pct = (last - i) / last;
            const score = Math.round(80 + pct * 15);
            r.job = { ...r.job, matchScore: score };
        });
    }
    const mergedScored = [...strictTier, ...relatedTier]
        .slice(0, limit)
        .map((r) => r.job);
    if (mergedScored.length === 0) {
        logger_1.logger.info(`aiJobSearch: "${query.slice(0, 60)}" → 0 (intent=${JSON.stringify({
            titles: intent.titleKeywords,
            skills: intent.skills,
            roles: intent.roleKeywords,
        })})`);
        return {
            intent,
            jobs: [],
            total: 0,
            scope: 'empty',
            nativeCount: 0,
            externalCount: 0,
        };
    }
    logger_1.logger.info(`aiJobSearch: "${query.slice(0, 60)}" → ${mergedScored.length} (${scope}; native=${nativeJobs.length}, external=${externalJobs.length})`);
    return {
        intent,
        jobs: mergedScored,
        total: mergedScored.length,
        scope,
        nativeCount: nativeJobs.length,
        externalCount: externalJobs.length,
    };
};
exports.aiJobSearch = aiJobSearch;
