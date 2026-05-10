import axios from 'axios';
import { BaseScraper } from './base';
import { ScrapedJob } from '../../types';
import { env } from '../../config/env';
import {
  JOB_FRESHNESS_DAYS,
  SCRAPER_TIMEOUT_MS,
  THEIRSTACK_API_URL,
} from '../../config/constants';

interface TheirStackJob {
  id: number | string;
  job_title: string;
  company?: string;
  company_object?: { name?: string };
  location?: string;
  short_location?: string;
  long_location?: string;
  country_code?: string;
  description?: string;
  url?: string;
  final_url?: string;
  date_posted?: string;
  remote?: boolean;
  hybrid?: boolean;
  salary_min?: number;
  salary_max?: number;
  salary_currency?: string;
  employment_statuses?: string[];
  technology_slugs?: string[];
}

interface TheirStackResponse {
  data: TheirStackJob[];
}

export class TheirStackScraper extends BaseScraper {
  source = 'theirstack' as const;

  // TheirStack bills per returned job; iterating per query+location would
  // burn credits fast. Batch every default query into a single POST per run.
  private fetchedThisRun = false;

  override resetForNewRun(): void {
    super.resetForNewRun();
    this.fetchedThisRun = false;
  }

  async fetch(query: string, _location = ''): Promise<ScrapedJob[]> {
    if (!env.THEIRSTACK_API_KEY) return [];
    if (this.fetchedThisRun) return [];
    if (await this.isCooldown()) return [];
    this.fetchedThisRun = true;

    try {
      const { data } = await axios.post<TheirStackResponse>(
        THEIRSTACK_API_URL,
        {
          page: 0,
          limit: 50,
          posted_at_max_age_days: JOB_FRESHNESS_DAYS,
          job_country_code_or: ['IN'],
          job_title_pattern_or: [
            'software engineer',
            'frontend developer',
            'backend developer',
            'full stack developer',
            'flutter developer',
            'react developer',
            'node.js developer',
            'data engineer',
            'devops engineer',
          ],
          include_total_results: false,
          order_by: [{ desc: true, field: 'date_posted' }],
        },
        {
          headers: {
            Authorization: `Bearer ${env.THEIRSTACK_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: SCRAPER_TIMEOUT_MS,
        },
      );

      const jobs = (data.data || [])
        .map((j): ScrapedJob => {
          const postedAt = j.date_posted ? new Date(j.date_posted) : new Date();
          const loc = j.long_location || j.short_location || j.location || j.country_code || 'Unknown';
          const desc = j.description || '';
          const remote = j.remote
            ? 'remote'
            : j.hybrid
              ? 'hybrid'
              : this.normalizeRemote(loc, desc);
          return {
            externalId: String(j.id),
            source: 'theirstack',
            title: j.job_title,
            company: j.company_object?.name || j.company || 'Unknown',
            location: loc,
            description: desc,
            url: j.final_url || j.url || '',
            salaryMin: j.salary_min,
            salaryMax: j.salary_max,
            currency: j.salary_currency,
            jobType: this.normalizeJobType(j.employment_statuses?.[0]),
            remoteType: remote,
            skills: [
              ...new Set([
                ...(j.technology_slugs || []).map((t) => t.toLowerCase()),
                ...this.extractSkills(desc),
              ]),
            ],
            postedAt,
            raw: j as unknown as Record<string, unknown>,
          };
        })
        .filter((j) => j.url && this.isWithinFreshness(j.postedAt));

      this.log(`Fetched ${jobs.length} fresh jobs`);
      return jobs;
    } catch (err) {
      await this.handleAxiosError(err, 'fetch theirstack');
      return [];
    }
  }
}
