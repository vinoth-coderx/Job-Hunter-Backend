"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GenericApiScraper = void 0;
const axios_1 = __importDefault(require("axios"));
const base_1 = require("./base");
const config_service_1 = require("../config/config.service");
class GenericApiScraper extends base_1.BaseScraper {
    source;
    cfg;
    label;
    constructor(parent) {
        super();
        if (!parent.generic) {
            throw new Error(`GenericApiScraper: config for ${parent.source} has no 'generic' block`);
        }
        this.source = parent.source;
        this.label = parent.label;
        this.cfg = parent.generic;
    }
    async fetch(query, location = '') {
        if (await this.isCooldown())
            return [];
        const out = [];
        const pages = Math.max(1, this.cfg.pageCount || 1);
        for (let page = 1; page <= pages; page++) {
            try {
                const items = await this.callPage(query, location, page);
                for (const item of items) {
                    const mapped = this.mapItem(item, query, location);
                    if (mapped)
                        out.push(mapped);
                }
                if (this.cfg.rateLimitMs > 0 && page < pages) {
                    await new Promise((r) => setTimeout(r, this.cfg.rateLimitMs));
                }
            }
            catch (err) {
                await this.handleAxiosError(err, `page ${page} (${query} @ ${location})`);
                break;
            }
        }
        return out;
    }
    buildAuthHeaders() {
        const headers = { ...(this.cfg.requestHeaders ?? {}) };
        if (this.cfg.authHeader && this.cfg.authValueConfigKey) {
            const v = (0, config_service_1.getAppConfig)(this.cfg.authValueConfigKey);
            if (typeof v === 'string' && v.length > 0) {
                headers[this.cfg.authHeader] = `${this.cfg.authValuePrefix ?? ''}${v}`;
            }
        }
        return headers;
    }
    interpolate(template, query, location, page) {
        return template
            .replace(/\{query\}/g, encodeURIComponent(query))
            .replace(/\{location\}/g, encodeURIComponent(location))
            .replace(/\{page\}/g, String(page));
    }
    async callPage(query, location, page) {
        let url = this.interpolate(this.cfg.endpointUrl, query, location, page);
        if (this.cfg.pageParam) {
            const sep = url.includes('?') ? '&' : '?';
            url += `${sep}${encodeURIComponent(this.cfg.pageParam)}=${page}`;
        }
        const headers = this.buildAuthHeaders();
        let res;
        if (this.cfg.httpMethod === 'POST') {
            const body = this.cfg.requestBody
                ? this.interpolate(this.cfg.requestBody, query, location, page)
                : undefined;
            const parsedBody = (() => {
                if (!body)
                    return undefined;
                try {
                    return JSON.parse(body);
                }
                catch {
                    return body;
                }
            })();
            res = await axios_1.default.post(url, parsedBody, {
                headers,
                timeout: 15000,
            });
        }
        else {
            res = await axios_1.default.get(url, { headers, timeout: 15000 });
        }
        const root = this.walk(res.data, this.cfg.responseRootPath);
        if (!Array.isArray(root)) {
            this.log(`responseRootPath did not resolve to an array (got ${typeof root})`);
            return [];
        }
        return root;
    }
    walk(obj, path) {
        if (!path)
            return obj;
        const parts = path.split('.').filter(Boolean);
        let cur = obj;
        for (const p of parts) {
            if (cur == null)
                return undefined;
            const idx = Number(p);
            if (!Number.isNaN(idx) && Array.isArray(cur)) {
                cur = cur[idx];
            }
            else if (typeof cur === 'object') {
                cur = cur[p];
            }
            else {
                return undefined;
            }
        }
        return cur;
    }
    str(item, path) {
        if (!path)
            return undefined;
        const v = this.walk(item, path);
        if (v == null)
            return undefined;
        if (typeof v === 'string')
            return v;
        if (typeof v === 'number' || typeof v === 'boolean')
            return String(v);
        return undefined;
    }
    mapItem(item, _query, _location) {
        const map = this.cfg.fieldMap;
        const title = this.str(item, map.title);
        const company = this.str(item, map.company);
        const url = this.str(item, map.url);
        const externalId = this.str(item, map.externalId);
        if (!title || !company || !url || !externalId) {
            return null;
        }
        const locationStr = this.str(item, map.location) ?? '';
        const description = this.str(item, map.description) ?? '';
        const postedAtRaw = this.str(item, map.postedAt);
        const postedAt = postedAtRaw ? new Date(postedAtRaw) : new Date();
        const safePostedAt = Number.isNaN(postedAt.getTime()) ? new Date() : postedAt;
        if (!this.isWithinFreshness(safePostedAt))
            return null;
        const job = {
            externalId,
            source: this.source,
            title,
            company,
            location: locationStr,
            description,
            url,
            jobType: this.normalizeJobType(this.str(item, map.type)),
            remoteType: this.normalizeRemote(locationStr, description),
            skills: this.extractSkills(description),
            postedAt: safePostedAt,
            raw: { provider: this.label, item: item },
        };
        return job;
    }
}
exports.GenericApiScraper = GenericApiScraper;
