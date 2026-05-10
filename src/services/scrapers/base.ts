import axios, { AxiosError } from 'axios';
import { ScrapedJob } from '../../types';
import { logger } from '../../utils/logger';
import { JOB_FRESHNESS_DAYS } from '../../config/constants';
import { redis } from '../../config/redis';

export abstract class BaseScraper {
  abstract source: string;

  private runFailureCount = 0;
  private static readonly MAX_FAILURES_PER_RUN = 2;

  abstract fetch(query: string, location?: string): Promise<ScrapedJob[]>;

  resetForNewRun(): void {
    this.runFailureCount = 0;
  }

  protected async isCooldown(): Promise<boolean> {
    const v = await redis.get(`scraper:cooldown:${this.source}`);
    if (v) {
      logger.debug(`[${this.source}] in cooldown — skipping (${v})`);
      return true;
    }
    return this.runFailureCount >= BaseScraper.MAX_FAILURES_PER_RUN;
  }

  protected async setCooldown(reason: string, seconds: number): Promise<void> {
    await redis.setex(`scraper:cooldown:${this.source}`, seconds, reason);
    logger.warn(
      `[${this.source}] cooldown set: ${reason} for ${seconds}s — will retry after`,
    );
  }

  protected async handleAxiosError(err: unknown, context: string): Promise<void> {
    this.runFailureCount += 1;

    if (axios.isAxiosError(err)) {
      const ae = err as AxiosError;
      const status = ae.response?.status;
      const data = ae.response?.data;
      const apiMsg =
        typeof data === 'object' && data && 'message' in data
          ? String((data as { message: unknown }).message)
          : typeof data === 'string'
            ? data.slice(0, 200)
            : ae.message;

      logger.warn(`[${this.source}] ${context} → ${status || 'NETWORK'}: ${apiMsg}`);

      if (status === 401 || status === 403) {
        await this.setCooldown(`auth/quota error ${status}`, 60 * 60);
        return;
      }
      if (status === 429) {
        await this.setCooldown('rate limited', 15 * 60);
        return;
      }
      if (!status && (ae.code === 'ECONNABORTED' || ae.code === 'ETIMEDOUT')) {
        await this.setCooldown('timeout', 5 * 60);
        return;
      }
      return;
    }

    logger.warn(`[${this.source}] ${context} → ${(err as Error).message}`);
  }

  protected isWithinFreshness(date: Date): boolean {
    const cutoff = new Date(Date.now() - JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
    return date >= cutoff;
  }

  protected log(msg: string, meta?: Record<string, unknown>): void {
    logger.info(`[${this.source}] ${msg}`, meta);
  }

  protected logError(msg: string, err: unknown): void {
    logger.error(`[${this.source}] ${msg}`, err);
  }

  protected normalizeJobType(raw?: string): ScrapedJob['jobType'] {
    if (!raw) return 'unknown';
    const r = raw.toLowerCase();
    if (r.includes('full')) return 'full-time';
    if (r.includes('part')) return 'part-time';
    if (r.includes('contract')) return 'contract';
    if (r.includes('intern')) return 'internship';
    if (r.includes('temp')) return 'temporary';
    return 'unknown';
  }

  protected normalizeRemote(loc?: string, desc?: string): ScrapedJob['remoteType'] {
    const text = `${loc || ''} ${desc || ''}`.toLowerCase();
    if (text.includes('remote') || text.includes('work from home')) return 'remote';
    if (text.includes('hybrid')) return 'hybrid';
    if (text.includes('onsite') || text.includes('on-site') || text.includes('in office'))
      return 'onsite';
    return 'unknown';
  }

  protected extractSkills(description: string): string[] {
    const skillKeywords = [
      'javascript', 'typescript', 'python', 'java', 'c++', 'c#', 'go', 'rust',
      'react', 'angular', 'vue', 'svelte', 'next.js', 'nuxt',
      'node.js', 'express', 'fastify', 'nest.js', 'django', 'flask', 'fastapi',
      'spring', 'laravel', 'rails',
      'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform',
      'mongodb', 'postgresql', 'mysql', 'redis', 'elasticsearch',
      'kafka', 'rabbitmq', 'graphql', 'rest', 'grpc',
      'flutter', 'react native', 'android', 'ios', 'swift', 'kotlin',
      'machine learning', 'ai', 'tensorflow', 'pytorch', 'data science',
      'devops', 'ci/cd', 'jenkins', 'github actions',
    ];
    const lower = description.toLowerCase();
    return skillKeywords.filter((s) => lower.includes(s));
  }
}
