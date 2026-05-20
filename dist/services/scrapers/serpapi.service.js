"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SerpApiScraper = void 0;
const axios_1 = __importDefault(require("axios"));
const base_1 = require("./base");
const config_service_1 = require("../config/config.service");
const constants_1 = require("../../config/constants");
class SerpApiScraper extends base_1.BaseScraper {
    source = 'serpapi';
    baseUrl = 'https://serpapi.com/search.json';
    mapDatePosted(days) {
        if (days <= 1)
            return 'today';
        if (days <= 3)
            return '3days';
        if (days <= 7)
            return 'week';
        return 'month';
    }
    async fetch(query, location = '') {
        const apiKey = (0, config_service_1.getAppConfig)('SERPAPI_KEY');
        if (this.needsKey(apiKey, 'SERPAPI_KEY'))
            return [];
        if (await this.isCooldown())
            return [];
        const days = this.freshnessDays();
        const datePosted = this.mapDatePosted(days);
        try {
            const { data } = await axios_1.default.get(this.baseUrl, {
                params: {
                    engine: 'google_jobs',
                    q: location ? `${query} ${location}` : query,
                    api_key: apiKey,
                    chips: `date_posted:${datePosted}`,
                    hl: 'en',
                },
                timeout: constants_1.SCRAPER_TIMEOUT_MS,
            });
            const results = data.jobs_results || [];
            const rawCount = results.length;
            const jobs = results
                .map((j, idx) => {
                const postedAt = this.parsePostedAt(j.detected_extensions?.posted_at);
                const url = j.apply_options?.[0]?.link ||
                    j.share_link ||
                    j.related_links?.[0]?.link ||
                    'https://google.com/search?q=' + encodeURIComponent(j.title);
                return {
                    externalId: j.job_id || `serp-${query}-${idx}-${postedAt.getTime()}`,
                    source: 'serpapi',
                    title: j.title,
                    company: j.company_name || 'Unknown',
                    location: j.location || location || 'Unknown',
                    description: j.description,
                    url,
                    jobType: this.normalizeJobType(j.detected_extensions?.schedule_type),
                    remoteType: this.normalizeRemote(j.location, j.description),
                    skills: this.extractSkills(j.description),
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
    parsePostedAt(text) {
        const now = new Date();
        if (!text)
            return now;
        const t = text.toLowerCase();
        const numMatch = t.match(/(\d+)/);
        const num = numMatch ? parseInt(numMatch[1], 10) : 0;
        let daysAgo = 0;
        if (t.includes('hour'))
            daysAgo = 0;
        else if (t.includes('day'))
            daysAgo = num;
        else if (t.includes('week'))
            daysAgo = num * 7;
        else if (t.includes('month'))
            daysAgo = num * 30;
        return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    }
}
exports.SerpApiScraper = SerpApiScraper;
