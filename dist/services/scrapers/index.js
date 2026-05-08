"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.puppeteerScraper = exports.rapid = exports.serp = exports.adzuna = exports.fetchAllJobs = void 0;
const adzuna_service_1 = require("./adzuna.service");
const serpapi_service_1 = require("./serpapi.service");
const rapidapi_service_1 = require("./rapidapi.service");
const puppeteer_service_1 = require("./puppeteer.service");
const Job_1 = require("../../models/Job");
const logger_1 = require("../../utils/logger");
const env_1 = require("../../config/env");
const adzuna = new adzuna_service_1.AdzunaScraper();
exports.adzuna = adzuna;
const serp = new serpapi_service_1.SerpApiScraper();
exports.serp = serp;
const rapid = new rapidapi_service_1.RapidApiScraper();
exports.rapid = rapid;
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
    for (const s of [adzuna, serp, rapid, puppeteerScraper])
        s.resetForNewRun();
    const all = [];
    const bySource = {
        adzuna: 0,
        serpapi: 0,
        rapidapi: 0,
        puppeteer: 0,
    };
    for (const query of queries) {
        for (const location of locations) {
            const tasks = [
                adzuna.fetch(query, location),
                serp.fetch(query, location),
                rapid.fetch(query, location),
            ];
            if (usePuppeteer)
                tasks.push(puppeteerScraper.fetch(query, location));
            const results = await Promise.allSettled(tasks);
            for (const r of results) {
                if (r.status === 'fulfilled') {
                    for (const j of r.value) {
                        all.push(j);
                        bySource[j.source] = (bySource[j.source] || 0) + 1;
                    }
                }
            }
        }
    }
    if (usePuppeteer) {
        await puppeteerScraper.close();
    }
    let inserted = 0;
    let updated = 0;
    for (const j of all) {
        try {
            const result = await Job_1.Job.updateOne({ externalId: j.externalId, source: j.source }, {
                $set: {
                    title: j.title,
                    company: j.company,
                    location: j.location,
                    description: j.description,
                    url: j.url,
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
            if (result.upsertedCount > 0)
                inserted++;
            else if (result.modifiedCount > 0)
                updated++;
        }
        catch (err) {
            logger_1.logger.warn('Failed to upsert job', { id: j.externalId, source: j.source, err });
        }
    }
    const cutoff = new Date(Date.now() - env_1.env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
    await Job_1.Job.updateMany({ postedAt: { $lt: cutoff } }, { $set: { isActive: false } });
    logger_1.logger.info(`Job fetch complete — total: ${all.length}, inserted: ${inserted}, updated: ${updated}`, bySource);
    return { total: all.length, inserted, updated, bySource };
};
exports.fetchAllJobs = fetchAllJobs;
