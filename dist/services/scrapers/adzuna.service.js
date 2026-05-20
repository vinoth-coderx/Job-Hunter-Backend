"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdzunaScraper = void 0;
const axios_1 = __importDefault(require("axios"));
const base_1 = require("./base");
const config_service_1 = require("../config/config.service");
const constants_1 = require("../../config/constants");
class AdzunaScraper extends base_1.BaseScraper {
    source = 'adzuna';
    baseUrl = 'https://api.adzuna.com/v1/api/jobs';
    async fetch(query, location = '') {
        const appId = (0, config_service_1.getAppConfig)('ADZUNA_APP_ID');
        const appKey = (0, config_service_1.getAppConfig)('ADZUNA_APP_KEY');
        if (this.needsKey(appId, 'ADZUNA_APP_ID'))
            return [];
        if (this.needsKey(appKey, 'ADZUNA_APP_KEY'))
            return [];
        if (await this.isCooldown())
            return [];
        const days = this.freshnessDays();
        try {
            const url = `${this.baseUrl}/${constants_1.ADZUNA_COUNTRY}/search/1`;
            const { data } = await axios_1.default.get(url, {
                params: {
                    app_id: appId,
                    app_key: appKey,
                    results_per_page: 50,
                    what: query,
                    where: location,
                    max_days_old: days,
                    sort_by: 'date',
                    'content-type': 'application/json',
                },
                timeout: constants_1.SCRAPER_TIMEOUT_MS,
            });
            const rawCount = (data.results || []).length;
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
                    currency: constants_1.ADZUNA_COUNTRY === 'in' ? 'INR' : 'USD',
                    jobType: this.normalizeJobType(j.contract_time || j.contract_type),
                    remoteType: this.normalizeRemote(j.location?.display_name, j.description),
                    skills: this.extractSkills(j.description),
                    postedAt,
                    raw: j,
                };
            })
                .filter((j) => this.isWithinFreshness(j.postedAt));
            this.log(`Fetched ${jobs.length} fresh jobs for "${query}" (${days}d window; raw=${rawCount})`);
            this.noteOk(jobs.length);
            return jobs;
        }
        catch (err) {
            await this.handleAxiosError(err, `fetch "${query}"`);
            return [];
        }
    }
}
exports.AdzunaScraper = AdzunaScraper;
