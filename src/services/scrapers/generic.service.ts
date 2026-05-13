import axios from 'axios';
import { BaseScraper } from './base';
import { ScrapedJob } from '../../types';
import { IJobSourceConfig, IGenericSourceConfig } from '../../models/JobSourceConfig';
import { getAppConfig } from '../config/config.service';

/**
 * Drives a fully admin-configured REST job source. One instance is built
 * per `JobSourceConfig` row of type `generic`. The fetch flow:
 *
 *   1. Interpolate `{query}`, `{location}`, `{page}` into endpoint URL
 *      (and request body for POST).
 *   2. Inject the auth header — value pulled from AppConfig so the
 *      secret lives in the same encrypted store as our other API keys.
 *   3. Walk `responseRootPath` to find the array of jobs.
 *   4. Map each item to ScrapedJob via `fieldMap` (dotted paths).
 *   5. Throttle between pages via `rateLimitMs`.
 *
 * Pagination is opt-in (`pageParam` + `pageCount`). For POST sources the
 * page substitutes `{page}` in `requestBody`. If `pageCount<=1` only a
 * single request fires per (query, location).
 *
 * Failures funnel through `BaseScraper.handleAxiosError` so cooldown +
 * tracker behaviour matches the builtin scrapers.
 */
export class GenericApiScraper extends BaseScraper {
  source: string;
  private cfg: IGenericSourceConfig;
  private label: string;

  constructor(parent: IJobSourceConfig) {
    super();
    if (!parent.generic) {
      throw new Error(
        `GenericApiScraper: config for ${parent.source} has no 'generic' block`,
      );
    }
    this.source = parent.source;
    this.label = parent.label;
    this.cfg = parent.generic;
  }

  async fetch(query: string, location = ''): Promise<ScrapedJob[]> {
    if (await this.isCooldown()) return [];

    const out: ScrapedJob[] = [];
    const pages = Math.max(1, this.cfg.pageCount || 1);

    for (let page = 1; page <= pages; page++) {
      try {
        const items = await this.callPage(query, location, page);
        for (const item of items) {
          const mapped = this.mapItem(item, query, location);
          if (mapped) out.push(mapped);
        }
        if (this.cfg.rateLimitMs > 0 && page < pages) {
          await new Promise((r) => setTimeout(r, this.cfg.rateLimitMs));
        }
      } catch (err) {
        await this.handleAxiosError(err, `page ${page} (${query} @ ${location})`);
        break;
      }
    }

    return out;
  }

  // ─── private helpers ───────────────────────────────────────────────

  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...(this.cfg.requestHeaders ?? {}) };
    if (this.cfg.authHeader && this.cfg.authValueConfigKey) {
      const v = getAppConfig(this.cfg.authValueConfigKey);
      if (typeof v === 'string' && v.length > 0) {
        headers[this.cfg.authHeader] = `${this.cfg.authValuePrefix ?? ''}${v}`;
      }
    }
    return headers;
  }

  private interpolate(
    template: string,
    query: string,
    location: string,
    page: number,
  ): string {
    return template
      .replace(/\{query\}/g, encodeURIComponent(query))
      .replace(/\{location\}/g, encodeURIComponent(location))
      .replace(/\{page\}/g, String(page));
  }

  private async callPage(
    query: string,
    location: string,
    page: number,
  ): Promise<unknown[]> {
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
        if (!body) return undefined;
        try { return JSON.parse(body); } catch { return body; }
      })();
      res = await axios.post(url, parsedBody, {
        headers,
        timeout: 15000,
      });
    } else {
      res = await axios.get(url, { headers, timeout: 15000 });
    }

    const root = this.walk(res.data, this.cfg.responseRootPath);
    if (!Array.isArray(root)) {
      this.log(`responseRootPath did not resolve to an array (got ${typeof root})`);
      return [];
    }
    return root;
  }

  /** Walk a dotted path (e.g. "data.results.0.jobs") into a value. */
  private walk(obj: unknown, path: string): unknown {
    if (!path) return obj;
    const parts = path.split('.').filter(Boolean);
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      const idx = Number(p);
      if (!Number.isNaN(idx) && Array.isArray(cur)) {
        cur = cur[idx];
      } else if (typeof cur === 'object') {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return cur;
  }

  private str(item: unknown, path?: string): string | undefined {
    if (!path) return undefined;
    const v = this.walk(item, path);
    if (v == null) return undefined;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return undefined;
  }

  private mapItem(
    item: unknown,
    _query: string,
    _location: string,
  ): ScrapedJob | null {
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

    if (!this.isWithinFreshness(safePostedAt)) return null;

    const job: ScrapedJob = {
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
      raw: { provider: this.label, item: item as Record<string, unknown> },
    };
    return job;
  }
}
