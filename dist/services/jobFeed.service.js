"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.lookupExternalJobFromCache = exports.filterApplied = exports.buildAppliedExclusion = exports.fetchExternalForProfile = exports.deriveProfileLocations = exports.deriveProfileQueries = exports.toFeedJobFromScraped = exports.hydrateTrust = exports.toFeedJobFromNative = exports.FEED_EXTERNAL_CACHE_TTL_SEC = void 0;
const redis_1 = require("../config/redis");
const scrapers_1 = require("./scrapers");
const logger_1 = require("../utils/logger");
const AppliedJob_1 = require("../models/AppliedJob");
const HirerProfile_1 = require("../models/HirerProfile");
const mongoose_1 = __importDefault(require("mongoose"));
exports.FEED_EXTERNAL_CACHE_TTL_SEC = 30 * 60;
const MAX_PROFILE_QUERIES = 3;
const MAX_PROFILE_LOCATIONS = 3;
const toFeedJobFromNative = (j) => ({
    id: j._id.toString(),
    _id: j._id.toString(),
    isNative: true,
    source: j.source,
    externalId: j.externalId,
    title: j.title,
    company: j.company,
    companyLogoUrl: j.companyLogoUrl,
    location: j.location,
    description: j.description,
    url: j.url,
    applyUrl: j.applyUrl,
    salaryMin: j.salaryMin,
    salaryMax: j.salaryMax,
    currency: j.currency,
    jobType: j.jobType,
    remoteType: j.remoteType,
    skills: j.skills,
    experienceMinYears: j.experienceMinYears,
    experienceMaxYears: j.experienceMaxYears,
    postedAt: j.postedAt,
    hirerProfile: j.hirerProfile?.toString(),
    postedBy: j.postedBy?.toString(),
    applyType: j.applyType,
    responsibilities: j.responsibilities,
    perks: j.perks,
    department: j.department,
});
exports.toFeedJobFromNative = toFeedJobFromNative;
const hydrateTrust = async (feed) => {
    const ids = new Set();
    for (const f of feed) {
        if (f.isNative && f.hirerProfile)
            ids.add(f.hirerProfile);
    }
    if (ids.size === 0)
        return feed;
    const profiles = await HirerProfile_1.HirerProfile.find({
        _id: { $in: Array.from(ids).map((id) => new mongoose_1.default.Types.ObjectId(id)) },
    })
        .select('verification.isVerified trustScore')
        .lean();
    const byId = new Map();
    for (const p of profiles) {
        byId.set(p._id.toString(), {
            verified: p.verification?.isVerified === true,
            trustScore: typeof p.trustScore === 'number' ? p.trustScore : 50,
        });
    }
    for (const f of feed) {
        if (!f.isNative || !f.hirerProfile)
            continue;
        const t = byId.get(f.hirerProfile);
        if (!t)
            continue;
        f.companyVerified = t.verified;
        f.recruiterTrustScore = t.trustScore;
    }
    return feed;
};
exports.hydrateTrust = hydrateTrust;
const toFeedJobFromScraped = (s) => ({
    id: `${s.source}:${s.externalId}`,
    isNative: false,
    source: s.source,
    externalId: s.externalId,
    title: s.title,
    company: s.company,
    companyLogoUrl: s.companyLogoUrl,
    location: s.location,
    description: s.description,
    url: s.url,
    applyUrl: s.applyUrl || s.url,
    salaryMin: s.salaryMin,
    salaryMax: s.salaryMax,
    currency: s.currency,
    jobType: s.jobType,
    remoteType: s.remoteType,
    skills: s.skills,
    postedAt: s.postedAt,
});
exports.toFeedJobFromScraped = toFeedJobFromScraped;
const deriveProfileQueries = (user, fallback) => {
    const queries = [];
    if (user) {
        queries.push(...(user.profile.preferredRoles || []).slice(0, MAX_PROFILE_QUERIES));
        if (queries.length < MAX_PROFILE_QUERIES) {
            queries.push(...(user.profile.skills || []).slice(0, MAX_PROFILE_QUERIES - queries.length));
        }
    }
    if (queries.length === 0 && fallback)
        queries.push(fallback);
    return queries
        .map((q) => q.trim())
        .filter((q) => q.length > 0)
        .slice(0, MAX_PROFILE_QUERIES);
};
exports.deriveProfileQueries = deriveProfileQueries;
const deriveProfileLocations = (user, fallback) => {
    const locs = [];
    if (user) {
        locs.push(...(user.profile.preferredLocations || []).slice(0, MAX_PROFILE_LOCATIONS));
    }
    if (locs.length === 0 && fallback)
        locs.push(fallback);
    return locs
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, MAX_PROFILE_LOCATIONS);
};
exports.deriveProfileLocations = deriveProfileLocations;
const normaliseForKey = (s) => s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const cacheKeyForExternal = (query, location) => `feed:ext:${normaliseForKey(query)}:${normaliseForKey(location) || 'any'}`;
const fetchExternalCached = async (query, location) => {
    const key = cacheKeyForExternal(query, location);
    try {
        const hit = await redis_1.redis.get(key);
        if (hit) {
            const parsed = JSON.parse(hit);
            return parsed.map((j) => ({ ...j, postedAt: new Date(j.postedAt) }));
        }
    }
    catch (e) {
        logger_1.logger.warn('jobFeed cache read failed', { key, err: e.message });
    }
    const live = await (0, scrapers_1.fetchAllJobsLive)({
        queries: [query],
        locations: location ? [location] : undefined,
    });
    try {
        await redis_1.redis.setex(key, exports.FEED_EXTERNAL_CACHE_TTL_SEC, JSON.stringify(live));
    }
    catch (e) {
        logger_1.logger.warn('jobFeed cache write failed', { key, err: e.message });
    }
    return live;
};
const fetchExternalForProfile = async (queries, locations) => {
    if (queries.length === 0)
        return [];
    const effectiveLocations = locations.length ? locations : [''];
    const seen = new Set();
    const out = [];
    for (const q of queries) {
        for (const loc of effectiveLocations) {
            const jobs = await fetchExternalCached(q, loc);
            for (const j of jobs) {
                const k = `${j.source}:${j.externalId}`;
                if (seen.has(k))
                    continue;
                seen.add(k);
                out.push(j);
            }
        }
    }
    return out;
};
exports.fetchExternalForProfile = fetchExternalForProfile;
const buildAppliedExclusion = async (userId) => {
    const exclusion = {
        jobIds: new Set(),
        externalKeys: new Set(),
    };
    if (!userId)
        return exclusion;
    const apps = await AppliedJob_1.AppliedJob.find({ user: userId })
        .select('job jobSnapshot.source jobSnapshot.externalId')
        .lean();
    for (const a of apps) {
        if (a.job)
            exclusion.jobIds.add(a.job.toString());
        const src = a.jobSnapshot?.source;
        const ext = a.jobSnapshot?.externalId;
        if (src && ext)
            exclusion.externalKeys.add(`${src}:${ext}`);
    }
    return exclusion;
};
exports.buildAppliedExclusion = buildAppliedExclusion;
const filterApplied = (jobs, applied) => jobs.filter((j) => {
    if (j.isNative)
        return !applied.jobIds.has(j.id);
    if (j.externalId) {
        return !applied.externalKeys.has(`${j.source}:${j.externalId}`);
    }
    return true;
});
exports.filterApplied = filterApplied;
const lookupExternalJobFromCache = async (source, externalId) => {
    try {
        let cursor = '0';
        do {
            const [next, keys] = await redis_1.redis.scan(cursor, 'MATCH', 'feed:ext:*', 'COUNT', 200);
            cursor = next;
            if (keys.length === 0)
                continue;
            const values = await redis_1.redis.mget(...keys);
            for (const v of values) {
                if (!v)
                    continue;
                try {
                    const list = JSON.parse(v);
                    const hit = list.find((j) => j.source === source && j.externalId === externalId);
                    if (hit)
                        return { ...hit, postedAt: new Date(hit.postedAt) };
                }
                catch {
                }
            }
        } while (cursor !== '0');
    }
    catch (e) {
        logger_1.logger.warn('lookupExternalJobFromCache failed', {
            source,
            externalId,
            err: e.message,
        });
    }
    return null;
};
exports.lookupExternalJobFromCache = lookupExternalJobFromCache;
