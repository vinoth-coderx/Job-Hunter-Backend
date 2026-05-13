import axios from 'axios';
import { BaseScraper } from './base';
import { ScrapedJob } from '../../types';
import { getAppConfig } from '../config/config.service';
import {
  SCRAPER_TIMEOUT_MS,
  THEIRSTACK_API_URL,
} from '../../config/constants';

/// Convert a free-text location ("Bangalore, India", "London", "Remote")
/// to an ISO 3166-1 alpha-2 country code TheirStack accepts. We only
/// map the regions Job Hunter actively targets — anything else falls
/// back to "IN" since the platform is India-first by default.
const guessCountryCode = (location: string): string => {
  const lc = location.toLowerCase();
  if (lc.includes('india') || lc.includes('bengaluru') || lc.includes('bangalore') ||
      lc.includes('mumbai') || lc.includes('delhi') || lc.includes('hyderabad') ||
      lc.includes('chennai') || lc.includes('pune') || lc.includes('kolkata')) return 'IN';
  if (lc.includes('united states') || lc.includes('usa') || lc.includes('us')) return 'US';
  if (lc.includes('united kingdom') || lc.includes('uk') || lc.includes('london')) return 'GB';
  if (lc.includes('canada')) return 'CA';
  if (lc.includes('australia')) return 'AU';
  if (lc.includes('singapore')) return 'SG';
  if (lc.includes('germany')) return 'DE';
  return 'IN';
};

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

  async fetch(query: string, location = ''): Promise<ScrapedJob[]> {
    const apiKey = getAppConfig('THEIRSTACK_API_KEY');
    if (!apiKey) return [];
    if (this.fetchedThisRun) return [];
    if (await this.isCooldown()) return [];
    if (!query || query.trim().length === 0) return [];
    this.fetchedThisRun = true;

    const country = guessCountryCode(location);
    const days = this.freshnessDays();

    try {
      const { data } = await axios.post<TheirStackResponse>(
        THEIRSTACK_API_URL,
        {
          page: 0,
          limit: 50,
          posted_at_max_age_days: days,
          job_country_code_or: [country],
          // The user's actual query drives the title filter now; the
          // previous hardcoded 9-pattern list ignored what the cron
          // (or downstream search) actually asked for, so TheirStack
          // returned 0 for everything outside that bucket.
          job_title_pattern_or: [query.trim()],
          include_total_results: false,
          order_by: [{ desc: true, field: 'date_posted' }],
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: SCRAPER_TIMEOUT_MS,
        },
      );

      const rawCount = (data.data || []).length;
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

      this.log(
        `Fetched ${jobs.length} fresh jobs for "${query}" in ${country} (${days}d window; raw=${rawCount})`,
      );
      return jobs;
    } catch (err) {
      await this.handleAxiosError(err, `fetch "${query}" theirstack`);
      return [];
    }
  }
}
