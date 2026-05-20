"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.puppeteerScraper = exports.arbeitnow = exports.realtimeWebSearch = exports.rapid = exports.serp = exports.adzuna = exports.fetchAllJobsLive = exports.fetchAllJobs = void 0;
const adzuna_service_1 = require("./adzuna.service");
const serpapi_service_1 = require("./serpapi.service");
const rapidapi_service_1 = require("./rapidapi.service");
const realtimeWebSearch_service_1 = require("./realtimeWebSearch.service");
const arbeitnow_service_1 = require("./arbeitnow.service");
const puppeteer_service_1 = require("./puppeteer.service");
const generic_service_1 = require("./generic.service");
const Job_1 = require("../../models/Job");
const logger_1 = require("../../utils/logger");
const constants_1 = require("../../config/constants");
const scraperTracker_1 = require("../../utils/scraperTracker");
const jobSourceConfig_service_1 = require("../jobSourceConfig.service");
const adzuna = new adzuna_service_1.AdzunaScraper();
exports.adzuna = adzuna;
const serp = new serpapi_service_1.SerpApiScraper();
exports.serp = serp;
const rapid = new rapidapi_service_1.RapidApiScraper();
exports.rapid = rapid;
const realtimeWebSearch = new realtimeWebSearch_service_1.RealtimeWebSearchScraper();
exports.realtimeWebSearch = realtimeWebSearch;
const arbeitnow = new arbeitnow_service_1.ArbeitnowScraper();
exports.arbeitnow = arbeitnow;
const puppeteerScraper = new puppeteer_service_1.PuppeteerScraper();
exports.puppeteerScraper = puppeteerScraper;
const DEFAULT_QUERIES = [
    'software engineer',
    'frontend developer',
    'backend developer',
    'full stack developer',
    'flutter developer',
    'react developer',
    'node.js developer',
    'data engineer',
    'devops engineer',
];
const DEFAULT_LOCATIONS = ['India', 'Bangalore', 'Chennai', 'Hyderabad', 'Pune', 'Remote'];
const fetchAllJobs = async (opts = {}) => {
    const queries = opts.queries?.length ? opts.queries : DEFAULT_QUERIES;
    const locations = opts.locations?.length ? opts.locations : DEFAULT_LOCATIONS;
    const usePuppeteer = opts.usePuppeteer ?? false;
    logger_1.logger.info(`Starting job fetch: ${queries.length} queries x ${locations.length} locations`);
    const sourceCfgs = await (0, jobSourceConfig_service_1.getJobSourceConfigs)().catch(() => []);
    const disabled = new Set(sourceCfgs.filter((c) => !c.enabled).map((c) => c.source));
    const isOn = (source) => !disabled.has(source);
    const genericScrapers = sourceCfgs
        .filter((c) => c.type === 'generic' && c.enabled && c.generic)
        .map((c) => new generic_service_1.GenericApiScraper(c));
    for (const s of [
        adzuna,
        serp,
        rapid,
        realtimeWebSearch,
        arbeitnow,
        puppeteerScraper,
        ...genericScrapers,
    ]) {
        s.resetForNewRun();
    }
    const all = [];
    const bySource = {
        adzuna: 0,
        serpapi: 0,
        rapidapi: 0,
        realtime_web_search: 0,
        arbeitnow: 0,
        puppeteer: 0,
    };
    for (const g of genericScrapers) {
        bySource[g.source] = 0;
    }
    const sourceDurationMs = {};
    const sourceErrors = {};
    const buildTasks = (query, location) => {
        const taskList = [];
        const time = (source, p) => {
            const started = Date.now();
            taskList.push({ source, promise: p, started });
        };
        if (isOn('adzuna'))
            time('adzuna', adzuna.fetch(query, location));
        if (isOn('serpapi'))
            time('serpapi', serp.fetch(query, location));
        if (isOn('rapidapi'))
            time('rapidapi', rapid.fetch(query, location));
        if (isOn('realtime_web_search'))
            time('realtime_web_search', realtimeWebSearch.fetch(query, location));
        if (isOn('arbeitnow'))
            time('arbeitnow', arbeitnow.fetch(query, location));
        if (usePuppeteer && isOn('puppeteer'))
            time('puppeteer', puppeteerScraper.fetch(query, location));
        for (const g of genericScrapers) {
            time(g.source, g.fetch(query, location));
        }
        return taskList;
    };
    for (const query of queries) {
        for (const location of locations) {
            const tasks = buildTasks(query, location);
            const results = await Promise.allSettled(tasks.map((t) => t.promise));
            for (let i = 0; i < results.length; i++) {
                const t = tasks[i];
                const r = results[i];
                sourceDurationMs[t.source] =
                    (sourceDurationMs[t.source] || 0) + (Date.now() - t.started);
                if (r.status === 'fulfilled') {
                    for (const j of r.value) {
                        all.push(j);
                        bySource[j.source] = (bySource[j.source] || 0) + 1;
                    }
                }
                else {
                    sourceErrors[t.source] = (sourceErrors[t.source] || 0) + 1;
                }
            }
        }
    }
    if (usePuppeteer) {
        await puppeteerScraper.close();
    }
    let inserted = 0;
    let updated = 0;
    const insertedBySource = {};
    const updatedBySource = {};
    for (const j of all) {
        try {
            const result = await Job_1.Job.updateOne({ externalId: j.externalId, source: j.source }, {
                $set: {
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
                    jobType: j.jobType ?? 'unknown',
                    remoteType: j.remoteType ?? 'unknown',
                    skills: j.skills ?? [],
                    postedAt: j.postedAt,
                    fetchedAt: new Date(),
                    isActive: true,
                    raw: j.raw,
                },
            }, { upsert: true });
            if (result.upsertedCount > 0) {
                inserted++;
                insertedBySource[j.source] = (insertedBySource[j.source] || 0) + 1;
            }
            else if (result.modifiedCount > 0) {
                updated++;
                updatedBySource[j.source] = (updatedBySource[j.source] || 0) + 1;
            }
        }
        catch (err) {
            logger_1.logger.warn('Failed to upsert job', { id: j.externalId, source: j.source, err });
        }
    }
    const cutoff = new Date(Date.now() - constants_1.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
    await Job_1.Job.updateMany({ postedAt: { $lt: cutoff } }, { $set: { isActive: false } });
    logger_1.logger.info(`Job fetch complete — total: ${all.length}, inserted: ${inserted}, updated: ${updated}`, bySource);
    const sourceToScraper = {
        adzuna,
        serpapi: serp,
        rapidapi: rapid,
        realtime_web_search: realtimeWebSearch,
        arbeitnow,
        puppeteer: puppeteerScraper,
    };
    for (const g of genericScrapers) {
        sourceToScraper[g.source] = g;
    }
    const sources = Object.keys(bySource);
    await Promise.all(sources.map((source) => {
        const scraperStatus = sourceToScraper[source]?.lastRunStatus;
        return (0, scraperTracker_1.recordScraperRun)(source, {
            total: bySource[source] || 0,
            inserted: insertedBySource[source] || 0,
            updated: updatedBySource[source] || 0,
            errors: sourceErrors[source] || 0,
            durationMs: sourceDurationMs[source] || 0,
            status: scraperStatus?.status,
            statusDetail: scraperStatus?.detail,
        });
    }));
    return { total: all.length, inserted, updated, bySource };
};
exports.fetchAllJobs = fetchAllJobs;
const fetchAllJobsLive = async (opts) => {
    const queries = opts.queries.filter((q) => q.trim().length > 0);
    if (queries.length === 0)
        return [];
    const locations = opts.locations?.length ? opts.locations : [''];
    const includeBulk = opts.includeBulkSources ?? false;
    const seen = new Set();
    const out = [];
    const sourceCfgs = await (0, jobSourceConfig_service_1.getJobSourceConfigs)().catch(() => []);
    const disabled = new Set(sourceCfgs.filter((c) => !c.enabled).map((c) => c.source));
    const isOn = (source) => !disabled.has(source);
    const genericScrapers = sourceCfgs
        .filter((c) => c.type === 'generic' && c.enabled && c.generic)
        .map((c) => new generic_service_1.GenericApiScraper(c));
    for (const query of queries) {
        for (const location of locations) {
            const tasks = [];
            if (isOn('adzuna'))
                tasks.push(adzuna.fetch(query, location));
            if (isOn('serpapi'))
                tasks.push(serp.fetch(query, location));
            if (isOn('rapidapi'))
                tasks.push(rapid.fetch(query, location));
            if (isOn('realtime_web_search'))
                tasks.push(realtimeWebSearch.fetch(query, location));
            if (includeBulk) {
                if (isOn('arbeitnow'))
                    tasks.push(arbeitnow.fetch(query, location));
            }
            for (const g of genericScrapers) {
                tasks.push(g.fetch(query, location));
            }
            const results = await Promise.allSettled(tasks);
            for (const r of results) {
                if (r.status !== 'fulfilled')
                    continue;
                for (const j of r.value) {
                    const key = `${j.source}:${j.externalId}`;
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    out.push(j);
                }
            }
        }
    }
    return out;
};
exports.fetchAllJobsLive = fetchAllJobsLive;
