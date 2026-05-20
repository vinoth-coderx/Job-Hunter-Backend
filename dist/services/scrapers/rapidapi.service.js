"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RapidApiScraper = void 0;
const axios_1 = __importDefault(require("axios"));
const base_1 = require("./base");
const config_service_1 = require("../config/config.service");
const constants_1 = require("../../config/constants");
const RAPIDAPI_JSEARCH_URL = 'https://jsearch.p.rapidapi.com/search';
const RAPIDAPI_JSEARCH_HOST = 'jsearch.p.rapidapi.com';
class RapidApiScraper extends base_1.BaseScraper {
    source = 'rapidapi';
    mapDatePosted(days) {
        if (days <= 1)
            return 'today';
        if (days <= 3)
            return '3days';
        if (days <= 7)
            return 'week';
        if (days <= 31)
            return 'month';
        return 'all';
    }
    pickApplyUrl(j) {
        const options = j.apply_options ?? [];
        const linkedin = options.find((o) => (o.publisher || '').toLowerCase() === 'linkedin' && o.apply_link);
        if (linkedin?.apply_link)
            return linkedin.apply_link;
        const direct = options.find((o) => o.is_direct === true && o.apply_link);
        if (direct?.apply_link)
            return direct.apply_link;
        if (j.employer_website && /^https?:\/\//i.test(j.employer_website)) {
            return j.employer_website;
        }
        const firstWithLink = options.find((o) => o.apply_link);
        if (firstWithLink?.apply_link)
            return firstWithLink.apply_link;
        return j.job_apply_link || undefined;
    }
    async fetch(query, location = '') {
        const rapidapiKey = (0, config_service_1.getAppConfig)('RAPIDAPI_KEY');
        const owNinjaKey = (0, config_service_1.getAppConfig)('OPENWEBNINJA_API_KEY');
        const apiKey = rapidapiKey || owNinjaKey;
        if (this.needsKey(apiKey, 'RAPIDAPI_KEY (or OPENWEBNINJA_API_KEY)'))
            return [];
        if (await this.isCooldown())
            return [];
        const usingRapidApi = Boolean(rapidapiKey);
        const url = (usingRapidApi
            ? (0, config_service_1.getAppConfig)('RAPIDAPI_JSEARCH_URL')
            : (0, config_service_1.getAppConfig)('OPENWEBNINJA_JSEARCH_URL')) ||
            (usingRapidApi ? RAPIDAPI_JSEARCH_URL : constants_1.OPENWEBNINJA_JSEARCH_URL);
        const authHeaders = usingRapidApi
            ? {
                'X-RapidAPI-Key': apiKey,
                'X-RapidAPI-Host': RAPIDAPI_JSEARCH_HOST,
                Accept: 'application/json',
            }
            : {
                'X-API-Key': apiKey,
                Accept: '*/*',
            };
        const days = this.freshnessDays();
        const datePosted = this.mapDatePosted(days);
        try {
            const { data } = await axios_1.default.get(url, {
                params: {
                    query: location ? `${query} in ${location}` : query,
                    num_pages: 1,
                    date_posted: datePosted,
                },
                headers: authHeaders,
                timeout: constants_1.SCRAPER_TIMEOUT_MS,
            });
            const rawCount = (data.data || []).length;
            const jobs = (data.data || [])
                .map((j) => {
                const postedAt = j.job_posted_at_datetime_utc
                    ? new Date(j.job_posted_at_datetime_utc)
                    : new Date();
                const loc = [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ');
                const applyUrl = this.pickApplyUrl(j);
                return {
                    externalId: j.job_id,
                    source: 'rapidapi',
                    title: j.job_title,
                    company: j.employer_name || 'Unknown',
                    companyLogoUrl: j.employer_logo ?? undefined,
                    location: loc || location || 'Unknown',
                    description: j.job_description,
                    url: j.job_apply_link,
                    applyUrl,
                    salaryMin: j.job_min_salary ?? undefined,
                    salaryMax: j.job_max_salary ?? undefined,
                    currency: j.job_salary_currency ?? undefined,
                    jobType: this.normalizeJobType(j.job_employment_type),
                    remoteType: j.job_is_remote ? 'remote' : this.normalizeRemote(loc, j.job_description),
                    skills: this.extractSkills(j.job_description),
                    postedAt,
                    raw: j,
                };
            })
                .filter((j) => this.isWithinFreshness(j.postedAt));
            this.log(`Fetched ${jobs.length} fresh jobs for "${query}" (${datePosted}/${days}d; raw=${rawCount})`);
            this.noteOk(jobs.length);
            return jobs;
        }
        catch (err) {
            await this.handleAxiosError(err, `fetch "${query}"`);
            return [];
        }
    }
}
exports.RapidApiScraper = RapidApiScraper;
