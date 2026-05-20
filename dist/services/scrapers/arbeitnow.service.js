"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArbeitnowScraper = void 0;
const axios_1 = __importDefault(require("axios"));
const base_1 = require("./base");
const constants_1 = require("../../config/constants");
class ArbeitnowScraper extends base_1.BaseScraper {
    source = 'arbeitnow';
    fetchedThisRun = false;
    resetForNewRun() {
        super.resetForNewRun();
        this.fetchedThisRun = false;
    }
    async fetch(query, location = '') {
        if (this.fetchedThisRun)
            return [];
        if (await this.isCooldown())
            return [];
        this.fetchedThisRun = true;
        try {
            const all = [];
            let nextUrl = constants_1.ARBEITNOW_API_URL;
            let pages = 0;
            while (nextUrl && pages < 5) {
                const { data } = await axios_1.default.get(nextUrl, {
                    timeout: constants_1.SCRAPER_TIMEOUT_MS,
                });
                const batch = data.data || [];
                all.push(...batch);
                const oldestInBatch = batch.length
                    ? new Date(Math.min(...batch.map((j) => j.created_at * 1000)))
                    : null;
                if (oldestInBatch && !this.isWithinFreshness(oldestInBatch))
                    break;
                nextUrl = data.links?.next || null;
                pages++;
            }
            const jobs = all
                .map((j) => {
                const postedAt = new Date(j.created_at * 1000);
                const desc = j.description || '';
                return {
                    externalId: j.slug,
                    source: 'arbeitnow',
                    title: j.title,
                    company: j.company_name || 'Unknown',
                    location: j.location || (j.remote ? 'Remote' : 'Unknown'),
                    description: desc,
                    url: j.url,
                    jobType: this.normalizeJobType(j.job_types?.[0]),
                    remoteType: j.remote ? 'remote' : this.normalizeRemote(j.location, desc),
                    skills: [
                        ...new Set([
                            ...(j.tags || []).map((t) => t.toLowerCase()),
                            ...this.extractSkills(desc),
                        ]),
                    ],
                    postedAt,
                    raw: j,
                };
            })
                .filter((j) => this.isWithinFreshness(j.postedAt));
            this.log(`Fetched ${jobs.length} fresh jobs (across ${pages} pages)`);
            this.noteOk(jobs.length);
            return jobs;
        }
        catch (err) {
            await this.handleAxiosError(err, 'fetch arbeitnow');
            return [];
        }
    }
}
exports.ArbeitnowScraper = ArbeitnowScraper;
