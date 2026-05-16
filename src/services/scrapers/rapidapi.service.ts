import axios from 'axios';
import { BaseScraper } from './base';
import { ScrapedJob } from '../../types';
import { getAppConfig } from '../config/config.service';
import { OPENWEBNINJA_JSEARCH_URL, SCRAPER_TIMEOUT_MS } from '../../config/constants';

/// JSearch has two valid hosts and we route to whichever key is set:
///
///   1. RapidAPI marketplace (canonical home, paid):
///        https://jsearch.p.rapidapi.com/search
///        Auth: X-RapidAPI-Key + X-RapidAPI-Host
///
///   2. OpenWebNinja (re-host, requires that account to subscribe to
///      JSearch as a product — not included in the base plan):
///        https://api.openwebninja.com/jsearch/search
///        Auth: X-API-Key
///
/// Earlier the scraper hardcoded OpenWebNinja and used the X-API-Key
/// header regardless of which key the operator pasted, which made the
/// `RAPIDAPI_KEY` fallback case silently 404 (wrong host) or 401 (wrong
/// auth header). Now the choice is explicit.
const RAPIDAPI_JSEARCH_URL = 'https://jsearch.p.rapidapi.com/search';
const RAPIDAPI_JSEARCH_HOST = 'jsearch.p.rapidapi.com';

/// JSearch (now hosted on OpenWebNinja, not RapidAPI). The internal
/// source slug stays `rapidapi` so existing rows keyed by
/// `(source, externalId)` don't collide on first run after migration.
///
/// v2 response is shaped the same as v1 but adds a richer
/// `job_apply_options[]` array and `employer_website`. We use those to
/// pick the *best* apply target at scrape-time so the seeker lands on
/// LinkedIn / the company's own site instead of an aggregator listing.

interface JSearchApplyOption {
  publisher?: string;
  apply_link?: string;
  is_direct?: boolean;
}

interface JSearchJob {
  job_id: string;
  job_title: string;
  employer_name: string;
  employer_logo?: string | null;
  employer_website?: string | null;
  job_publisher?: string;
  job_employment_type?: string;
  job_apply_link: string;
  job_apply_is_direct?: boolean;
  /// JSearch v2 names this `apply_options` (NOT `job_apply_options`).
  /// Each entry: { publisher, apply_link, is_direct }.
  apply_options?: JSearchApplyOption[];
  job_description: string;
  job_is_remote?: boolean | null;
  job_posted_at_datetime_utc?: string | null;
  job_city?: string | null;
  job_state?: string | null;
  job_country?: string | null;
  job_min_salary?: number | null;
  job_max_salary?: number | null;
  job_salary_currency?: string | null;
  job_google_link?: string | null;
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

  /// Priority for the redirect-on-apply target:
  ///   1. LinkedIn apply link        (most seekers already have a profile)
  ///   2. Direct / official employer site (is_direct = true)
  ///   3. employer_website fallback  (company careers landing page)
  ///   4. first apply option         (any aggregator)
  ///   5. job_apply_link             (final fallback — primary publisher)
  ///
  /// We always return *something* if any URL exists; callers should
  /// treat the result as best-effort.
  private pickApplyUrl(j: JSearchJob): string | undefined {
    const options = j.apply_options ?? [];

    const linkedin = options.find(
      (o) => (o.publisher || '').toLowerCase() === 'linkedin' && o.apply_link,
    );
    if (linkedin?.apply_link) return linkedin.apply_link;

    const direct = options.find((o) => o.is_direct === true && o.apply_link);
    if (direct?.apply_link) return direct.apply_link;

    if (j.employer_website && /^https?:\/\//i.test(j.employer_website)) {
      return j.employer_website;
    }

    const firstWithLink = options.find((o) => o.apply_link);
    if (firstWithLink?.apply_link) return firstWithLink.apply_link;

    return j.job_apply_link || undefined;
  }

  async fetch(query: string, location = ''): Promise<ScrapedJob[]> {
    // Pick the host that matches the key the operator actually set.
    // RAPIDAPI_KEY wins if both are present — it's the canonical
    // JSearch home and is more likely to be on a paid plan.
    const rapidapiKey = getAppConfig('RAPIDAPI_KEY');
    const owNinjaKey = getAppConfig('OPENWEBNINJA_API_KEY');
    const apiKey = rapidapiKey || owNinjaKey;
    if (this.needsKey(apiKey, 'RAPIDAPI_KEY (or OPENWEBNINJA_API_KEY)')) return [];
    if (await this.isCooldown()) return [];

    const usingRapidApi = Boolean(rapidapiKey);
    // Admin override — pin the exact URL for either host without a
    // redeploy. RAPIDAPI_JSEARCH_URL / OPENWEBNINJA_JSEARCH_URL keys
    // are read at request time so AppConfig writes take effect instantly.
    const url =
      (usingRapidApi
        ? getAppConfig('RAPIDAPI_JSEARCH_URL')
        : getAppConfig('OPENWEBNINJA_JSEARCH_URL')) ||
      (usingRapidApi ? RAPIDAPI_JSEARCH_URL : OPENWEBNINJA_JSEARCH_URL);
    const authHeaders = usingRapidApi
      ? {
          'X-RapidAPI-Key': apiKey!,
          'X-RapidAPI-Host': RAPIDAPI_JSEARCH_HOST,
          Accept: 'application/json',
        }
      : {
          'X-API-Key': apiKey!,
          Accept: '*/*',
        };

    const days = this.freshnessDays();
    const datePosted = this.mapDatePosted(days);

    try {
      const { data } = await axios.get<JSearchResponse>(url, {
        params: {
          query: location ? `${query} in ${location}` : query,
          num_pages: 1,
          date_posted: datePosted,
        },
        headers: authHeaders,
        timeout: SCRAPER_TIMEOUT_MS,
      });

      const rawCount = (data.data || []).length;
      const jobs = (data.data || [])
        .map((j): ScrapedJob => {
          const postedAt = j.job_posted_at_datetime_utc
            ? new Date(j.job_posted_at_datetime_utc)
            : new Date();
          const loc = [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ');
          const applyUrl = this.pickApplyUrl(j);
          return {
            externalId: j.job_id,
            source: 'rapidapi',
            title: j.job_title,
            company: j.employer_name || 'Unknown',
            companyLogoUrl: j.employer_logo ?? undefined,
            location: loc || location || 'Unknown',
            description: j.job_description,
            // `url` = primary apply link from the publisher (kept for
            // backwards compatibility with anything still reading it).
            url: j.job_apply_link,
            applyUrl,
            salaryMin: j.job_min_salary ?? undefined,
            salaryMax: j.job_max_salary ?? undefined,
            currency: j.job_salary_currency ?? undefined,
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
      this.noteOk(jobs.length);
      return jobs;
    } catch (err) {
      await this.handleAxiosError(err, `fetch "${query}"`);
      return [];
    }
  }
}
