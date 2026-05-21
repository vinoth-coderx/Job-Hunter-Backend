import type { Browser } from 'puppeteer-core';
import { env } from '../config/env';
import { PUPPETEER_HEADLESS } from '../config/constants';

/**
 * Shared Puppeteer launcher.
 *
 * Local dev uses the full `puppeteer` package (which bundles its own
 * Chromium during `npm install`) — easiest devx, no system chrome
 * required. Production (Render's Node runtime, 512 MB cap) swaps to
 * `puppeteer-core` + `@sparticuz/chromium`, a lightweight Chromium build
 * tuned for serverless/low-memory environments. Without this split,
 * vanilla puppeteer either fails to download Chromium at build time on
 * Render or OOMs at runtime when it boots.
 *
 * Each caller still owns its own `Browser` lifecycle — the helper just
 * returns a fresh instance. Pages should be opened/closed by the caller.
 */
export const launchBrowser = async (): Promise<Browser> => {
  if (env.NODE_ENV === 'production') {
    const { default: chromium } = await import('@sparticuz/chromium');
    const { default: puppeteerCore } = await import('puppeteer-core');
    return puppeteerCore.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    }) as unknown as Browser;
  }
  // Dev / staging — full puppeteer (bundled Chromium).
  const { default: puppeteer } = await import('puppeteer');
  return puppeteer.launch({
    headless: PUPPETEER_HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  }) as unknown as Browser;
};
