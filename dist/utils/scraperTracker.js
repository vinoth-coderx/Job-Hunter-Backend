"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KNOWN_SCRAPERS = exports.readScraperStats = exports.recordScraperRun = void 0;
const redis_1 = require("../config/redis");
const logger_1 = require("./logger");
const HISTORY_CAP = 100;
const latestKey = (source) => `scraper:run:${source}`;
const historyKey = (source) => `scraper:history:${source}`;
const recordScraperRun = async (source, stats) => {
    const record = {
        ...stats,
        ts: new Date().toISOString(),
    };
    try {
        const hashPayload = {
            lastRunAt: record.ts,
            lastJobsFetched: stats.total.toString(),
            lastInserted: stats.inserted.toString(),
            lastUpdated: stats.updated.toString(),
            lastErrors: stats.errors.toString(),
            lastDurationMs: stats.durationMs.toString(),
        };
        if (stats.status)
            hashPayload.lastStatus = stats.status;
        if (stats.statusDetail)
            hashPayload.lastStatusDetail = stats.statusDetail;
        await redis_1.redis.hset(latestKey(source), hashPayload);
        if (!stats.status) {
            await redis_1.redis.hdel(latestKey(source), 'lastStatus', 'lastStatusDetail');
        }
        else if (!stats.statusDetail) {
            await redis_1.redis.hdel(latestKey(source), 'lastStatusDetail');
        }
        await redis_1.redis.hincrby(latestKey(source), 'runCount', 1);
        if (stats.errors > 0) {
            await redis_1.redis.hincrby(latestKey(source), 'totalErrors', stats.errors);
        }
        await redis_1.redis.lpush(historyKey(source), JSON.stringify(record));
        await redis_1.redis.ltrim(historyKey(source), 0, HISTORY_CAP - 1);
    }
    catch (err) {
        logger_1.logger.warn(`scraperTracker write failed for ${source}: ${err}`);
    }
};
exports.recordScraperRun = recordScraperRun;
const readScraperStats = async (source, windowMs = 24 * 60 * 60 * 1000) => {
    let raw = {};
    let history = [];
    try {
        raw = await redis_1.redis.hgetall(latestKey(source));
        history = await redis_1.redis.lrange(historyKey(source), 0, HISTORY_CAP - 1);
    }
    catch (err) {
        logger_1.logger.warn(`scraperTracker read failed for ${source}: ${err}`);
    }
    const cutoff = Date.now() - windowMs;
    let runs = 0;
    let totalJobs = 0;
    let newJobs = 0;
    let duplicates = 0;
    let errors = 0;
    let durationSum = 0;
    for (const blob of history) {
        try {
            const r = JSON.parse(blob);
            if (new Date(r.ts).getTime() < cutoff)
                continue;
            runs += 1;
            totalJobs += r.total;
            newJobs += r.inserted;
            duplicates += r.total - r.inserted;
            errors += r.errors;
            durationSum += r.durationMs;
        }
        catch {
        }
    }
    return {
        source,
        lastRunAt: raw.lastRunAt || null,
        lastJobsFetched: parseInt(raw.lastJobsFetched ?? '0', 10) || 0,
        lastInserted: parseInt(raw.lastInserted ?? '0', 10) || 0,
        lastUpdated: parseInt(raw.lastUpdated ?? '0', 10) || 0,
        lastErrors: parseInt(raw.lastErrors ?? '0', 10) || 0,
        lastDurationMs: parseInt(raw.lastDurationMs ?? '0', 10) || 0,
        lastStatus: raw.lastStatus || null,
        lastStatusDetail: raw.lastStatusDetail || null,
        runCount: parseInt(raw.runCount ?? '0', 10) || 0,
        totalErrors: parseInt(raw.totalErrors ?? '0', 10) || 0,
        window: {
            runs,
            totalJobs,
            newJobs,
            duplicates,
            errors,
            avgDurationMs: runs > 0 ? Math.round(durationSum / runs) : 0,
        },
    };
};
exports.readScraperStats = readScraperStats;
exports.KNOWN_SCRAPERS = [
    {
        source: 'adzuna',
        label: 'Adzuna',
        category: 'Job Board API',
        pricing: 'Freemium',
        keyConfigKeys: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],
        isKeyless: false,
    },
    {
        source: 'serpapi',
        label: 'SerpApi',
        category: 'Google Jobs',
        pricing: 'Paid',
        keyConfigKeys: ['SERPAPI_KEY'],
        isKeyless: false,
    },
    {
        source: 'rapidapi',
        label: 'JSearch (OpenWebNinja)',
        category: 'Job Board API',
        pricing: 'Freemium',
        keyConfigKeys: ['OPENWEBNINJA_API_KEY'],
        isKeyless: false,
        notes: 'Hosted on api.openwebninja.com/jsearch/search-v2 (auth: X-API-Key).',
    },
    {
        source: 'realtime_web_search',
        label: 'Real-Time Web Search',
        category: 'Web Search',
        pricing: 'Freemium',
        keyConfigKeys: ['OPENWEBNINJA_API_KEY'],
        isKeyless: false,
        notes: 'OpenWebNinja Real-Time Web Search — surfaces direct careers pages and niche boards JSearch misses.',
    },
    {
        source: 'arbeitnow',
        label: 'Arbeitnow',
        category: 'EU Jobs',
        pricing: 'Free',
        keyConfigKeys: [],
        isKeyless: true,
        notes: 'No key required — always on',
    },
    {
        source: 'puppeteer',
        label: 'Puppeteer',
        category: 'Web Scraper',
        pricing: 'Free',
        keyConfigKeys: [],
        isKeyless: true,
        notes: 'No key required — headless browser',
    },
];
