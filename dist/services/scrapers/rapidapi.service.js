"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RapidApiScraper = void 0;
const axios_1 = __importDefault(require("axios"));
const base_1 = require("./base");
const env_1 = require("../../config/env");
const constants_1 = require("../../config/constants");
class RapidApiScraper extends base_1.BaseScraper {
    source = 'rapidapi';
    async fetch(query, location = '') {
        if (!env_1.env.RAPIDAPI_KEY)
            return [];
        if (await this.isCooldown())
            return [];
        try {
            const url = `https://${env_1.env.RAPIDAPI_JSEARCH_HOST}/search`;
            const { data } = await axios_1.default.get(url, {
                params: {
                    query: location ? `${query} in ${location}` : query,
                    page: 1,
                    num_pages: 1,
                    date_posted: 'week',
                },
                headers: {
                    'X-RapidAPI-Key': env_1.env.RAPIDAPI_KEY,
                    'X-RapidAPI-Host': env_1.env.RAPIDAPI_JSEARCH_HOST,
                },
                timeout: constants_1.SCRAPER_TIMEOUT_MS,
            });
            const jobs = (data.data || [])
                .map((j) => {
                const postedAt = j.job_posted_at_datetime_utc
                    ? new Date(j.job_posted_at_datetime_utc)
                    : new Date();
                const loc = [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ');
                return {
                    externalId: j.job_id,
                    source: 'rapidapi',
                    title: j.job_title,
                    company: j.employer_name || 'Unknown',
                    location: loc || location || 'Unknown',
                    description: j.job_description,
                    url: j.job_apply_link,
                    salaryMin: j.job_min_salary,
                    salaryMax: j.job_max_salary,
                    currency: j.job_salary_currency,
                    jobType: this.normalizeJobType(j.job_employment_type),
                    remoteType: j.job_is_remote ? 'remote' : this.normalizeRemote(loc, j.job_description),
                    skills: this.extractSkills(j.job_description),
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
exports.RapidApiScraper = RapidApiScraper;
