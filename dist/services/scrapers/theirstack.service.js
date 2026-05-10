"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TheirStackScraper = void 0;
const axios_1 = __importDefault(require("axios"));
const base_1 = require("./base");
const env_1 = require("../../config/env");
const constants_1 = require("../../config/constants");
class TheirStackScraper extends base_1.BaseScraper {
    source = 'theirstack';
    fetchedThisRun = false;
    resetForNewRun() {
        super.resetForNewRun();
        this.fetchedThisRun = false;
    }
    async fetch(query, _location = '') {
        if (!env_1.env.THEIRSTACK_API_KEY)
            return [];
        if (this.fetchedThisRun)
            return [];
        if (await this.isCooldown())
            return [];
        this.fetchedThisRun = true;
        try {
            const { data } = await axios_1.default.post(constants_1.THEIRSTACK_API_URL, {
                page: 0,
                limit: 50,
                posted_at_max_age_days: constants_1.JOB_FRESHNESS_DAYS,
                job_country_code_or: ['IN'],
                job_title_pattern_or: [
                    'software engineer',
                    'frontend developer',
                    'backend developer',
                    'full stack developer',
                    'flutter developer',
                    'react developer',
                    'node.js developer',
                    'data engineer',
                    'devops engineer',
                ],
                include_total_results: false,
                order_by: [{ desc: true, field: 'date_posted' }],
            }, {
                headers: {
                    Authorization: `Bearer ${env_1.env.THEIRSTACK_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                timeout: constants_1.SCRAPER_TIMEOUT_MS,
            });
            const jobs = (data.data || [])
                .map((j) => {
                const postedAt = j.date_posted ? new Date(j.date_posted) : new Date();
                const loc = j.long_location || j.short_location || j.location || j.country_code || 'Unknown';
                const desc = j.description || '';
                const remote = j.remote
                    ? 'remote'
                    : j.hybrid
                        ? 'hybrid'
                        : this.normalizeRemote(loc, desc);
                return {
                    externalId: String(j.id),
                    source: 'theirstack',
                    title: j.job_title,
                    company: j.company_object?.name || j.company || 'Unknown',
                    location: loc,
                    description: desc,
                    url: j.final_url || j.url || '',
                    salaryMin: j.salary_min,
                    salaryMax: j.salary_max,
                    currency: j.salary_currency,
                    jobType: this.normalizeJobType(j.employment_statuses?.[0]),
                    remoteType: remote,
                    skills: [
                        ...new Set([
                            ...(j.technology_slugs || []).map((t) => t.toLowerCase()),
                            ...this.extractSkills(desc),
                        ]),
                    ],
                    postedAt,
                    raw: j,
                };
            })
                .filter((j) => j.url && this.isWithinFreshness(j.postedAt));
            this.log(`Fetched ${jobs.length} fresh jobs`);
            return jobs;
        }
        catch (err) {
            await this.handleAxiosError(err, 'fetch theirstack');
            return [];
        }
    }
}
exports.TheirStackScraper = TheirStackScraper;
