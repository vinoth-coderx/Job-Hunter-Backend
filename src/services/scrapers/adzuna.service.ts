import axios from 'axios';
import { BaseScraper } from './base';
import { ScrapedJob } from '../../types';
import { getAppConfig } from '../config/config.service';
import { ADZUNA_COUNTRY, SCRAPER_TIMEOUT_MS } from '../../config/constants';

interface AdzunaJob {
  id: string;
  title: string;
  description: string;
  redirect_url: string;
  company: { display_name: string };
  location: { display_name: string };
  salary_min?: number;
  salary_max?: number;
  contract_time?: string;
  contract_type?: string;
  created: string;
}

interface AdzunaResponse {
  results: AdzunaJob[];
  count: number;
}

export class AdzunaScraper extends BaseScraper {
  source = 'adzuna' as const;
  private baseUrl = 'https://api.adzuna.com/v1/api/jobs';

  async fetch(query: string, location = ''): Promise<ScrapedJob[]> {
    const appId = getAppConfig('ADZUNA_APP_ID');
    const appKey = getAppConfig('ADZUNA_APP_KEY');
    if (!appId || !appKey) return [];
    if (await this.isCooldown()) return [];

    const days = this.freshnessDays();

    try {
      const url = `${this.baseUrl}/${ADZUNA_COUNTRY}/search/1`;
      const { data } = await axios.get<AdzunaResponse>(url, {
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
        timeout: SCRAPER_TIMEOUT_MS,
      });

      const rawCount = (data.results || []).length;
      const jobs = (data.results || [])
        .map((j): ScrapedJob => {
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
            currency: ADZUNA_COUNTRY === 'in' ? 'INR' : 'USD',
            jobType: this.normalizeJobType(j.contract_time || j.contract_type),
            remoteType: this.normalizeRemote(j.location?.display_name, j.description),
            skills: this.extractSkills(j.description),
            postedAt,
            raw: j as unknown as Record<string, unknown>,
          };
        })
        .filter((j) => this.isWithinFreshness(j.postedAt));

      this.log(
        `Fetched ${jobs.length} fresh jobs for "${query}" (${days}d window; raw=${rawCount})`,
      );
      return jobs;
    } catch (err) {
      await this.handleAxiosError(err, `fetch "${query}"`);
      return [];
    }
  }
}
