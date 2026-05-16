import axios from 'axios';
import { BaseScraper } from './base';
import { ScrapedJob } from '../../types';
import { ARBEITNOW_API_URL, SCRAPER_TIMEOUT_MS } from '../../config/constants';

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
}

interface ArbeitnowResponse {
  data: ArbeitnowJob[];
  links?: { next?: string | null };
}

export class ArbeitnowScraper extends BaseScraper {
  source = 'arbeitnow' as const;

  // Arbeitnow returns the global latest-jobs feed; per-query iteration
  // would yield identical pages. Fetch once per orchestrator run.
  private fetchedThisRun = false;

  override resetForNewRun(): void {
    super.resetForNewRun();
    this.fetchedThisRun = false;
  }

  async fetch(query: string, location = ''): Promise<ScrapedJob[]> {
    if (this.fetchedThisRun) return [];
    if (await this.isCooldown()) return [];
    this.fetchedThisRun = true;

    try {
      const all: ArbeitnowJob[] = [];
      let nextUrl: string | null = ARBEITNOW_API_URL;
      let pages = 0;

      // Walk the paginated feed until results fall outside the freshness
      // window. Cap pages so a quiet day doesn't drain the whole list.
      while (nextUrl && pages < 5) {
        const { data }: { data: ArbeitnowResponse } = await axios.get<ArbeitnowResponse>(nextUrl, {
          timeout: SCRAPER_TIMEOUT_MS,
        });
        const batch = data.data || [];
        all.push(...batch);

        const oldestInBatch = batch.length
          ? new Date(Math.min(...batch.map((j) => j.created_at * 1000)))
          : null;
        if (oldestInBatch && !this.isWithinFreshness(oldestInBatch)) break;

        nextUrl = data.links?.next || null;
        pages++;
      }

      const jobs = all
        .map((j): ScrapedJob => {
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
            raw: j as unknown as Record<string, unknown>,
          };
        })
        .filter((j) => this.isWithinFreshness(j.postedAt));

      this.log(`Fetched ${jobs.length} fresh jobs (across ${pages} pages)`);
      this.noteOk(jobs.length);
      return jobs;
    } catch (err) {
      await this.handleAxiosError(err, 'fetch arbeitnow');
      return [];
    }
  }
}
