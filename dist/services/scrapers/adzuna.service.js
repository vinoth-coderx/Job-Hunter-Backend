"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdzunaScraper = void 0;
const axios_1 = __importDefault(require("axios"));
const base_1 = require("./base");
const env_1 = require("../../config/env");
const constants_1 = require("../../config/constants");
class AdzunaScraper extends base_1.BaseScraper {
    source = 'adzuna';
    baseUrl = 'https://api.adzuna.com/v1/api/jobs';
    async fetch(query, location = '') {
        if (!env_1.env.ADZUNA_APP_ID || !env_1.env.ADZUNA_APP_KEY)
            return [];
        if (await this.isCooldown())
            return [];
        try {
            const url = `${this.baseUrl}/${env_1.env.ADZUNA_COUNTRY}/search/1`;
            const { data } = await axios_1.default.get(url, {
                params: {
                    app_id: env_1.env.ADZUNA_APP_ID,
                    app_key: env_1.env.ADZUNA_APP_KEY,
                    results_per_page: 50,
                    what: query,
                    where: location,
                    max_days_old: env_1.env.JOB_FRESHNESS_DAYS,
                    sort_by: 'date',
                    'content-type': 'application/json',
                },
                timeout: constants_1.SCRAPER_TIMEOUT_MS,
            });
            const jobs = (data.results || [])
                .map((j) => {
                const postedAt = new Date(j.created);
                return {
                    externalId: j.id,
                    source: 'adzuna',
                    title: j.title,
                    company: j.company?.display_name || 'Unknown',
                    location: j.location?.display_name || location || 'Unknown',
                    description: j.description,
                    url: j.redirect_url,
                    salaryMin: j.salary_min,
                    salaryMax: j.salary_max,
                    currency: env_1.env.ADZUNA_COUNTRY === 'in' ? 'INR' : 'USD',
                    jobType: this.normalizeJobType(j.contract_time || j.contract_type),
                    remoteType: this.normalizeRemote(j.location?.display_name, j.description),
                    skills: this.extractSkills(j.description),
                    postedAt,
                    raw: j,
                };
            })
                .filter((j) => this.isWithinFreshness(j.postedAt));
            this.log(`Fetched ${jobs.length} fresh jobs for "${query}"`);
            return jobs;
        }
        catch (err) {
            await this.handleAxiosError(err, `fetch "${query}"`);
            return [];
        }
    }
}
exports.AdzunaScraper = AdzunaScraper;
