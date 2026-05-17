import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';

/**
 * File-backed runtime mode selector. The Mongo + Redis URIs the process
 * connects to at boot are driven by this value. Persisted to a tiny file
 * in `secrets/.runtime-mode` (gitignored) so a redeploy or pm2 restart
 * preserves the operator's last choice. Default is `'live'` to keep
 * production safe when the file is missing.
 *
 * Flipping the mode requires a process restart — Mongoose models bind
 * to a Mongo connection at construction, and ~25 modules cache a Redis
 * singleton at import. Restart is the only safe way to repoint them.
 */
export type RuntimeMode = 'test' | 'live';

export const DEFAULT_RUNTIME_MODE: RuntimeMode = 'live';

const MODE_FILE = path.resolve(
  process.cwd(),
  'secrets',
  '.runtime-mode',
);

let cached: RuntimeMode | null = null;

const parse = (raw: string | undefined | null): RuntimeMode => {
  return raw === 'test' ? 'test' : 'live';
};

/**
 * Read the persisted runtime mode. Caches after first read — the file
 * is checked once per process boot; subsequent flips happen via
 * `writeRuntimeMode` + process restart.
 */
export const readRuntimeMode = (): RuntimeMode => {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(MODE_FILE, 'utf8').trim();
    cached = parse(raw);
    return cached;
  } catch {
    // ENOENT or unreadable — fall back to env override, then default.
    const envOverride = process.env.RUNTIME_MODE;
    cached = parse(envOverride);
    return cached;
  }
};

/**
 * Persist the new runtime mode to disk. Caller must trigger a process
 * restart afterwards — this function does NOT swap any open
 * connections, it only updates the value that the next boot will read.
 */
export const writeRuntimeMode = (mode: RuntimeMode): void => {
  const dir = path.dirname(MODE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(MODE_FILE, mode, { encoding: 'utf8', mode: 0o600 });
  cached = mode;
  logger.info(`Runtime mode persisted to ${MODE_FILE}: ${mode}`);
};
