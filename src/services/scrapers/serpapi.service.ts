import axios from 'axios';
import { BaseScraper } from './base';
import { ScrapedJob } from '../../types';
import { env } from '../../config/env';
import { SCRAPER_TIMEOUT_MS } from '../../config/constants';

interface SerpJobResult {
  job_id?: string;
  title: string;
  company_name: string;
  location: string;
  description: string;
  via: string;
  detected_extensions?: {
    posted_at?: string;
    schedule_type?: string;
    salary?: string;
  };
  related_links?: { link?: string }[];
  share_link?: string;
  apply_options?: { link: string }[];
}

interface SerpResponse {
  jobs_results?: SerpJobResult[];
}

export class SerpApiScraper extends BaseScraper {
  source = 'serpapi' as const;
  private baseUrl = 'https://serpapi.com/search.json';

  async fetch(query: string, location = ''): Promise<ScrapedJob[]> {
    if (!env.SERPAPI_KEY) return [];
    if (await this.isCooldown()) return [];

    try {
      const { data } = await axios.get<SerpResponse>(this.baseUrl, {
        params: {
          engine: 'google_jobs',
          q: location ? `${query} ${location}` : query,
          api_key: env.SERPAPI_KEY,
          chips: 'date_posted:week',
          hl: 'en',
        },
        timeout: SCRAPER_TIMEOUT_MS,
      });

      const results = data.jobs_results || [];

      const jobs = results
        .map((j, idx): ScrapedJob => {
          const postedAt = this.parsePostedAt(j.detected_extensions?.posted_at);
          const url =
            j.apply_options?.[0]?.link ||
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
            raw: j as unknown as Record<string, unknown>,
          };
        })
        .filter((j) => this.isWithinFreshness(j.postedAt));

      this.log(`Fetched ${jobs.length} fresh jobs for "${query}"`);
      return jobs;
    } catch (err) {
      await this.handleAxiosError(err, `fetch "${query}"`);
      return [];
    }
  }

  private parsePostedAt(text?: string): Date {
    const now = new Date();
    if (!text) return now;
    const t = text.toLowerCase();
    const numMatch = t.match(/(\d+)/);
    const num = numMatch ? parseInt(numMatch[1], 10) : 0;
    let daysAgo = 0;
    if (t.includes('hour')) daysAgo = 0;
    else if (t.includes('day')) daysAgo = num;
    else if (t.includes('week')) daysAgo = num * 7;
    else if (t.includes('month')) daysAgo = num * 30;
    return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  }
}
