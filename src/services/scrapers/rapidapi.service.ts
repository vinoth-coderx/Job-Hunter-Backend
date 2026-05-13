import axios from 'axios';
import { BaseScraper } from './base';
import { ScrapedJob } from '../../types';
import { getAppConfig } from '../config/config.service';
import { RAPIDAPI_JSEARCH_HOST, SCRAPER_TIMEOUT_MS } from '../../config/constants';

interface JSearchJob {
  job_id: string;
  job_title: string;
  employer_name: string;
  employer_logo?: string;
  job_publisher?: string;
  job_employment_type?: string;
  job_apply_link: string;
  job_description: string;
  job_is_remote?: boolean;
  job_posted_at_datetime_utc?: string;
  job_city?: string;
  job_state?: string;
  job_country?: string;
  job_min_salary?: number;
  job_max_salary?: number;
  job_salary_currency?: string;
}

interface JSearchResponse {
  data: JSearchJob[];
  status: string;
}

export class RapidApiScraper extends BaseScraper {
  source = 'rapidapi' as const;

  /// Map the configured freshness window to JSearch's discrete
  /// `date_posted` enum. JSearch supports: today (1d), 3days, week
  /// (7d), month (~30d), all. Picking the smallest bucket that still
  /// covers the configured days gives us the freshest result set the
  /// API can express.
  private mapDatePosted(days: number): 'today' | '3days' | 'week' | 'month' | 'all' {
    if (days <= 1) return 'today';
    if (days <= 3) return '3days';
    if (days <= 7) return 'week';
    if (days <= 31) return 'month';
    return 'all';
  }

  async fetch(query: string, location = ''): Promise<ScrapedJob[]> {
    const apiKey = getAppConfig('RAPIDAPI_KEY');
    if (!apiKey) return [];
    if (await this.isCooldown()) return [];

    const days = this.freshnessDays();
    const datePosted = this.mapDatePosted(days);

    try {
      const url = `https://${RAPIDAPI_JSEARCH_HOST}/search`;
      const { data } = await axios.get<JSearchResponse>(url, {
        params: {
          query: location ? `${query} in ${location}` : query,
          page: 1,
          num_pages: 1,
          date_posted: datePosted,
        },
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': RAPIDAPI_JSEARCH_HOST,
        },
        timeout: SCRAPER_TIMEOUT_MS,
      });

      const rawCount = (data.data || []).length;
      const jobs = (data.data || [])
        .map((j): ScrapedJob => {
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
            raw: j as unknown as Record<string, unknown>,
          };
        })
        .filter((j) => this.isWithinFreshness(j.postedAt));

      this.log(
        `Fetched ${jobs.length} fresh jobs for "${query}" (${datePosted}/${days}d; raw=${rawCount})`,
      );
      return jobs;
    } catch (err) {
      await this.handleAxiosError(err, `fetch "${query}"`);
      return [];
    }
  }
}
