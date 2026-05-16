import axios, { AxiosError } from 'axios';
import { ScrapedJob } from '../../types';
import { logger } from '../../utils/logger';
import { JOB_FRESHNESS_DAYS } from '../../config/constants';
import { redis } from '../../config/redis';
import { getAppConfig } from '../config/config.service';

/// Per-source freshness — admins set `JOB_FRESHNESS_DAYS_<SOURCE>`
/// (e.g. JOB_FRESHNESS_DAYS_ADZUNA = "30") in the App Config panel
/// to dial each scraper independently. Falls back to the global
/// JOB_FRESHNESS_DAYS constant when the per-source key is unset or
/// malformed. Bounded to [1, 365] so a typo can't fetch the entire
/// archive or zero everything out.
export const getFreshnessDaysForSource = (source: string): number => {
  const raw = getAppConfig(`JOB_FRESHNESS_DAYS_${source.toUpperCase()}`);
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) {
    return Math.min(365, Math.max(1, Math.round(n)));
  }
  return JOB_FRESHNESS_DAYS;
};

/**
 * Coarse-grained reason the scraper produced (or didn't produce) jobs on
 * its last call. Surfaced to the admin dashboard so 0-job rows can tell
 * the operator WHY: an unconfigured key reads differently from a 401, a
 * cooldown, or a working API that legitimately returned nothing.
 */
export type ScraperRunStatus =
  | 'ok'
  | 'no_key'
  | 'cooldown'
  | 'auth_error'
  | 'rate_limited'
  | 'network_error'
  | 'empty_query'
  | 'parse_error'
  | 'unknown';

const STATUS_PRIORITY: Record<ScraperRunStatus, number> = {
  // Higher = "stickier" — once we hit auth_error in a run we don't want
  // a later `ok` (which might have been from a cached/empty result) to
  // overwrite it. The dashboard needs to surface the most actionable
  // signal seen during the run.
  unknown: 0,
  ok: 1,
  empty_query: 2,
  no_key: 3,
  cooldown: 4,
  network_error: 5,
  rate_limited: 6,
  parse_error: 7,
  auth_error: 8,
};

export abstract class BaseScraper {
  abstract source: string;

  private runFailureCount = 0;
  private static readonly MAX_FAILURES_PER_RUN = 2;

  /// Last status observed across fetch() invocations within the current
  /// orchestrator run. `resetForNewRun()` clears it back to 'unknown'.
  /// Read by `index.ts` after the run finishes and stored on the
  /// scraperTracker so the admin dashboard can show it as a status pill.
  private _lastStatus: ScraperRunStatus = 'unknown';
  private _lastStatusDetail: string | undefined;

  abstract fetch(query: string, location?: string): Promise<ScrapedJob[]>;

  resetForNewRun(): void {
    this.runFailureCount = 0;
    this._lastStatus = 'unknown';
    this._lastStatusDetail = undefined;
  }

  /**
   * Records a status seen during fetch(). The highest-priority status
   * (per STATUS_PRIORITY) wins for the run — so a single 401 sticks even
   * if later calls return 'ok' from a cached/empty path.
   */
  protected noteStatus(status: ScraperRunStatus, detail?: string): void {
    if (STATUS_PRIORITY[status] >= STATUS_PRIORITY[this._lastStatus]) {
      this._lastStatus = status;
      this._lastStatusDetail = detail;
    }
  }

  /** Read-only accessor used by the orchestrator when recording stats. */
  get lastRunStatus(): { status: ScraperRunStatus; detail?: string } {
    return { status: this._lastStatus, detail: this._lastStatusDetail };
  }

  protected async isCooldown(): Promise<boolean> {
    const v = await redis.get(`scraper:cooldown:${this.source}`);
    if (v) {
      logger.debug(`[${this.source}] in cooldown — skipping (${v})`);
      this.noteStatus('cooldown', v);
      return true;
    }
    if (this.runFailureCount >= BaseScraper.MAX_FAILURES_PER_RUN) {
      this.noteStatus('cooldown', 'failure threshold reached');
      return true;
    }
    return false;
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
        this.noteStatus('auth_error', `HTTP ${status}: ${apiMsg.slice(0, 80)}`);
        await this.setCooldown(`auth/quota error ${status}`, 60 * 60);
        return;
      }
      if (status === 429) {
        this.noteStatus('rate_limited', apiMsg.slice(0, 80));
        await this.setCooldown('rate limited', 15 * 60);
        return;
      }
      if (!status && (ae.code === 'ECONNABORTED' || ae.code === 'ETIMEDOUT')) {
        this.noteStatus('network_error', 'timeout');
        await this.setCooldown('timeout', 5 * 60);
        return;
      }
      this.noteStatus('network_error', `HTTP ${status ?? '?'}: ${apiMsg.slice(0, 80)}`);
      return;
    }

    logger.warn(`[${this.source}] ${context} → ${(err as Error).message}`);
    this.noteStatus('network_error', (err as Error).message.slice(0, 80));
  }

  /// Days back this scraper accepts. Reads the per-source App Config
  /// key on every call so admin tweaks take effect on the next cron
  /// without a restart.
  protected freshnessDays(): number {
    return getFreshnessDaysForSource(this.source);
  }

  protected isWithinFreshness(date: Date): boolean {
    const cutoff = new Date(
      Date.now() - this.freshnessDays() * 24 * 60 * 60 * 1000,
    );
    return date >= cutoff;
  }

  protected log(msg: string, meta?: Record<string, unknown>): void {
    logger.info(`[${this.source}] ${msg}`, meta);
  }

  /**
   * Sugar around `noteStatus('no_key')` + a single warn log per fetch.
   * Returns true so callers can `if (this.needsKey(apiKey, 'X_KEY')) return [];`.
   */
  protected needsKey(value: string | null | undefined, keyName: string): boolean {
    if (value && value.trim().length > 0) return false;
    this.noteStatus('no_key', `missing AppConfig key: ${keyName}`);
    logger.warn(`[${this.source}] skipped — AppConfig key '${keyName}' is not set`);
    return true;
  }

  /**
   * Convenience for the common "we ran the API call and got N items"
   * path. Records `'ok'` with the count so the admin can tell apart
   * "ran, got 0" from "didn't run".
   */
  protected noteOk(count: number): void {
    this.noteStatus('ok', `returned ${count}`);
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
