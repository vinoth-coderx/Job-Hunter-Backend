import puppeteer, { Browser } from 'puppeteer';
import { BaseScraper } from './base';
import { ScrapedJob } from '../../types';
import { env } from '../../config/env';
import { PUPPETEER_HEADLESS, SCRAPER_TIMEOUT_MS } from '../../config/constants';

export class PuppeteerScraper extends BaseScraper {
  source = 'puppeteer' as const;
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser;
    this.browser = await puppeteer.launch({
      headless: PUPPETEER_HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    return this.browser;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async fetch(query: string, location = ''): Promise<ScrapedJob[]> {
    if (await this.isCooldown()) return [];

    const browser = await this.getBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(SCRAPER_TIMEOUT_MS);
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    );

    try {
      const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(query)}&l=${encodeURIComponent(location)}&fromage=${env.JOB_FRESHNESS_DAYS}&sort=date`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      const jobs = (await page.evaluate(`(() => {
        const src = ${JSON.stringify(this.source)};
        const cards = Array.from(document.querySelectorAll('.job_seen_beacon, .result'));
        return cards.slice(0, 25).map((card) => {
          const titleEl = card.querySelector('h2 a, .jobTitle a');
          const compEl = card.querySelector('[data-testid="company-name"], .companyName');
          const locEl = card.querySelector('[data-testid="text-location"], .companyLocation');
          const descEl = card.querySelector('.job-snippet, .summary');
          const dateEl = card.querySelector('.date, [data-testid="myJobsStateDate"]');
          const link = (titleEl && titleEl.href) || '';
          const dataJk = card.getAttribute('data-jk') || '';
          return {
            externalId: dataJk || link || (src + '-' + Math.random().toString(36).slice(2)),
            title: (titleEl && titleEl.textContent && titleEl.textContent.trim()) || 'Unknown',
            company: (compEl && compEl.textContent && compEl.textContent.trim()) || 'Unknown',
            location: (locEl && locEl.textContent && locEl.textContent.trim()) || 'Unknown',
            description: (descEl && descEl.textContent && descEl.textContent.trim()) || '',
            url: link.indexOf('http') === 0 ? link : ('https://www.indeed.com' + link),
            postedText: (dateEl && dateEl.textContent && dateEl.textContent.trim()) || '',
          };
        });
      })()`)) as Array<{
        externalId: string;
        title: string;
        company: string;
        location: string;
        description: string;
        url: string;
        postedText: string;
      }>;

      const result: ScrapedJob[] = jobs.map((j) => ({
        externalId: j.externalId,
        source: 'puppeteer',
        title: j.title,
        company: j.company,
        location: j.location,
        description: j.description,
        url: j.url,
        jobType: 'unknown',
        remoteType: this.normalizeRemote(j.location, j.description),
        skills: this.extractSkills(j.description),
        postedAt: this.parseRelativeDate(j.postedText),
      }));

      const fresh = result.filter((j) => this.isWithinFreshness(j.postedAt));
      this.log(`Scraped ${fresh.length} fresh jobs for "${query}"`);
      return fresh;
    } catch (err) {
      this.logError(`Failed to scrape "${query}"`, err);
      return [];
    } finally {
      await page.close();
    }
  }

  private parseRelativeDate(text: string): Date {
    const now = new Date();
    if (!text) return now;
    const numMatch = text.match(/(\d+)/);
    const num = numMatch ? parseInt(numMatch[1], 10) : 0;
    const t = text.toLowerCase();
    let daysAgo = 0;
    if (t.includes('today') || t.includes('just')) daysAgo = 0;
    else if (t.includes('day')) daysAgo = num;
    else if (t.includes('week')) daysAgo = num * 7;
    else if (t.includes('month')) daysAgo = num * 30;
    return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  }
}
