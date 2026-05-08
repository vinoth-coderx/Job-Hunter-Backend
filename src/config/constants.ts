export const PUPPETEER_HEADLESS = true;
export const SCRAPER_TIMEOUT_MS = 30_000;

// Generous default for a multi-screen app: a fresh launch easily fires
// 20-30 requests (feed, applied, saved, notifications, profile, alerts)
// and the user comfortably racks up another 50+ in a few minutes of
// browsing. 600/15min ~= 40/min steady state — still tight enough to
// block scraping but doesn't surface "Too many requests" mid-session.
// Override at runtime via RATE_LIMIT_MAX_REQUESTS / RATE_LIMIT_WINDOW_MS.
export const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) > 0
  ? Number(process.env.RATE_LIMIT_WINDOW_MS)
  : 15 * 60 * 1000;
export const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) > 0
  ? Number(process.env.RATE_LIMIT_MAX_REQUESTS)
  : 600;
