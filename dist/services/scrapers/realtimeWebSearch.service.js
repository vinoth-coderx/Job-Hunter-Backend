"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealtimeWebSearchScraper = void 0;
const axios_1 = __importDefault(require("axios"));
const base_1 = require("./base");
const config_service_1 = require("../config/config.service");
const constants_1 = require("../../config/constants");
const JOB_DOMAINS = [
    'linkedin.com/jobs',
    'indeed.com',
    'naukri.com',
    'glassdoor.com',
    'monster.com',
    'wellfound.com',
    'angel.co',
    'lever.co',
    'greenhouse.io',
    'workday.com',
    'workdayjobs.com',
    'smartrecruiters.com',
    'jobvite.com',
    'recruitee.com',
    'careers.google.com',
    'jobs.apple.com',
    'amazon.jobs',
    'careers.microsoft.com',
    'instahyre.com',
    'cutshort.io',
    'hirect.in',
    'foundit.in',
    'shine.com',
    'timesjobs.com',
];
const JOB_KEYWORDS = [
    'hiring',
    'careers',
    'opening',
    'opportunity',
    'vacancy',
    'apply now',
    'job description',
    'we are looking',
    'join our',
    'role:',
];
class RealtimeWebSearchScraper extends base_1.BaseScraper {
    source = 'realtime_web_search';
    looksLikeJob(r) {
        const url = (r.url || r.link || '').toLowerCase();
        if (JOB_DOMAINS.some((d) => url.includes(d)))
            return true;
        const haystack = `${r.title || ''} ${r.snippet || r.description || ''}`.toLowerCase();
        return JOB_KEYWORDS.some((k) => haystack.includes(k));
    }
    inferCompany(r) {
        const title = r.title || '';
        const atMatch = title.match(/\bat\s+(.+?)(?:\s+[·|\-—]|\s+in\s+|$)/i);
        if (atMatch?.[1])
            return atMatch[1].trim();
        const sepMatch = title.split(/\s+[·|]\s+/);
        if (sepMatch.length >= 2)
            return sepMatch[1].trim();
        const url = r.url || r.link || '';
        try {
            const host = new URL(url).hostname.replace(/^www\./, '');
            const root = host.split('.')[0];
            return root.charAt(0).toUpperCase() + root.slice(1);
        }
        catch {
            return r.domain || 'Unknown';
        }
    }
    idFor(url) {
        try {
            const u = new URL(url);
            return `${u.host}${u.pathname}`.toLowerCase().slice(0, 200);
        }
        catch {
            return url.slice(0, 200);
        }
    }
    async fetch(query, location = '') {
        const apiKey = (0, config_service_1.getAppConfig)('OPENWEBNINJA_API_KEY');
        if (this.needsKey(apiKey, 'OPENWEBNINJA_API_KEY'))
            return [];
        if (await this.isCooldown())
            return [];
        const url = (0, config_service_1.getAppConfig)('OPENWEBNINJA_WEBSEARCH_URL') || constants_1.OPENWEBNINJA_WEBSEARCH_URL;
        const q = location
            ? `${query} jobs in ${location} hiring 2026`
            : `${query} jobs hiring 2026`;
        try {
            const { data } = await axios_1.default.get(url, {
                params: { q, limit: 20 },
                headers: {
                    'X-API-Key': apiKey,
                    Accept: '*/*',
                },
                timeout: constants_1.SCRAPER_TIMEOUT_MS,
            });
            const results = data.data || [];
            const jobs = [];
            for (const r of results) {
                const url = r.url || r.link;
                if (!url || !/^https?:\/\//i.test(url))
                    continue;
                if (!this.looksLikeJob(r))
                    continue;
                const title = (r.title || '').trim();
                if (!title)
                    continue;
                const description = (r.snippet || r.description || '').trim();
                const company = this.inferCompany(r);
                jobs.push({
                    externalId: this.idFor(url),
                    source: this.source,
                    title,
                    company,
                    location: location || 'Unknown',
                    description,
                    url,
                    applyUrl: url,
                    jobType: this.normalizeJobType(title),
                    remoteType: this.normalizeRemote(location, `${title} ${description}`),
                    skills: this.extractSkills(`${title} ${description}`),
                    postedAt: new Date(),
                    raw: r,
                });
            }
            this.log(`Fetched ${jobs.length} job-shaped results for "${q}" (raw=${results.length})`);
            this.noteOk(jobs.length);
            return jobs;
        }
        catch (err) {
            await this.handleAxiosError(err, `fetch "${query}"`);
            return [];
        }
    }
}
exports.RealtimeWebSearchScraper = RealtimeWebSearchScraper;
