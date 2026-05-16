import axios from 'axios';
import { BaseScraper } from './base';
import { ScrapedJob } from '../../types';
import { getAppConfig } from '../config/config.service';
import { OPENWEBNINJA_WEBSEARCH_URL, SCRAPER_TIMEOUT_MS } from '../../config/constants';

/// OpenWebNinja's Real-Time Web Search returns Google-style web results
/// for an arbitrary query. We use it as a *complementary* source on top
/// of JSearch:
///
///   - JSearch covers indexed job boards (LinkedIn / Indeed / Naukri via
///     Google for Jobs).
///   - Real-Time Web Search picks up everything else — direct careers
///     pages, niche boards, fresh postings that haven't propagated to
///     the aggregators yet.
///
/// The challenge: results are generic web pages, not structured jobs.
/// We filter the result list down to plausible job postings (must look
/// like a job-board URL or have job keywords in the title) and best-
/// effort extract company from the domain. Whatever we can't infer
/// gracefully degrades — the seeker still gets a clickable card.

interface WebSearchResult {
  title?: string;
  url?: string;
  link?: string;
  snippet?: string;
  description?: string;
  domain?: string;
  position?: number;
}

interface WebSearchResponse {
  status?: string;
  data?: WebSearchResult[];
}

/// Domains that almost always host job listings. Hits here are kept as
/// jobs without extra title-checks.
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

export class RealtimeWebSearchScraper extends BaseScraper {
  source = 'realtime_web_search' as const;

  /// Treat a result as a job posting if either the URL hits a known
  /// job-board domain OR the title/snippet contains a job keyword.
  /// Conservative — false positives mean clicking through to a non-job
  /// page; we'd rather drop a result than spam the feed.
  private looksLikeJob(r: WebSearchResult): boolean {
    const url = (r.url || r.link || '').toLowerCase();
    if (JOB_DOMAINS.some((d) => url.includes(d))) return true;
    const haystack = `${r.title || ''} ${r.snippet || r.description || ''}`.toLowerCase();
    return JOB_KEYWORDS.some((k) => haystack.includes(k));
  }

  /// Pull a usable company name out of a result. Most job-board pages
  /// title their listings as "Role · Company · Location" or include the
  /// company in the URL path (e.g. /company/acme/jobs/123). We try
  /// title-parse first, then fall back to a humanised hostname.
  private inferCompany(r: WebSearchResult): string {
    const title = r.title || '';
    // Look for "Role at Company" / "Role · Company"
    const atMatch = title.match(/\bat\s+(.+?)(?:\s+[·|\-—]|\s+in\s+|$)/i);
    if (atMatch?.[1]) return atMatch[1].trim();
    const sepMatch = title.split(/\s+[·|]\s+/);
    if (sepMatch.length >= 2) return sepMatch[1].trim();

    // Fallback: derive from domain (linkedin.com → LinkedIn).
    const url = r.url || r.link || '';
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const root = host.split('.')[0];
      return root.charAt(0).toUpperCase() + root.slice(1);
    } catch {
      return r.domain || 'Unknown';
    }
  }

  /// Build a stable externalId from the result URL so re-runs don't
  /// duplicate listings. Hash-equivalent: lowercased URL minus query.
  private idFor(url: string): string {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`.toLowerCase().slice(0, 200);
    } catch {
      return url.slice(0, 200);
    }
  }

  async fetch(query: string, location = ''): Promise<ScrapedJob[]> {
    const apiKey = getAppConfig('OPENWEBNINJA_API_KEY');
    if (this.needsKey(apiKey, 'OPENWEBNINJA_API_KEY')) return [];
    if (await this.isCooldown()) return [];

    // OpenWebNinja has used multiple URL slugs for this product
    // (`realtime-web-search`, `real-time-web-search`); the gateway 403s
    // on the wrong one and the right slug varies by plan. Operators can
    // pin it via the AppConfig key `OPENWEBNINJA_WEBSEARCH_URL` without
    // a redeploy. Falling back to the compile-time constant otherwise.
    const url = getAppConfig('OPENWEBNINJA_WEBSEARCH_URL') || OPENWEBNINJA_WEBSEARCH_URL;

    // Bias the search toward fresh job postings. The endpoint doesn't
    // expose a recency knob, so we shape the query instead.
    const q = location
      ? `${query} jobs in ${location} hiring 2026`
      : `${query} jobs hiring 2026`;

    try {
      const { data } = await axios.get<WebSearchResponse>(url, {
        params: { q, limit: 20 },
        headers: {
          'X-API-Key': apiKey,
          Accept: '*/*',
        },
        timeout: SCRAPER_TIMEOUT_MS,
      });

      const results = data.data || [];
      const jobs: ScrapedJob[] = [];
      for (const r of results) {
        const url = r.url || r.link;
        if (!url || !/^https?:\/\//i.test(url)) continue;
        if (!this.looksLikeJob(r)) continue;

        const title = (r.title || '').trim();
        if (!title) continue;

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
          // For web-search results we have only one URL — it IS the
          // apply target. Setting both fields keeps downstream code
          // (jobFeed → Flutter) happy.
          applyUrl: url,
          jobType: this.normalizeJobType(title),
          remoteType: this.normalizeRemote(location, `${title} ${description}`),
          skills: this.extractSkills(`${title} ${description}`),
          // No posted-at in web search; assume "just seen".
          postedAt: new Date(),
          raw: r as unknown as Record<string, unknown>,
        });
      }

      this.log(
        `Fetched ${jobs.length} job-shaped results for "${q}" (raw=${results.length})`,
      );
      this.noteOk(jobs.length);
      return jobs;
    } catch (err) {
      await this.handleAxiosError(err, `fetch "${query}"`);
      return [];
    }
  }
}
