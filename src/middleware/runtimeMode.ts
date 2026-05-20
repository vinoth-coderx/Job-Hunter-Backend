import { Request, Response, NextFunction } from 'express';
import {
  DEFAULT_RUNTIME_MODE,
  runWithMode,
  type RuntimeMode,
} from '../config/dbConnections';

/**
 * Per-request runtime-mode middleware. Reads the `X-Runtime-Mode`
 * header — if it's `test` or `live`, wraps the rest of the request
 * handler chain in `runWithMode(mode, …)` so every Mongo + Redis
 * lookup inside that chain sees the correct mode via
 * AsyncLocalStorage. Falls back to the default mode (`live`) when the
 * header is missing or invalid.
 *
 * Intended for `/admin/*` routes only. Public Flutter-app endpoints
 * do NOT mount this — they always see the default (live) connection
 * so a malicious client can't probe the test DB by sending a header.
 */
export const runtimeModeFromHeader = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const raw = req.header('x-runtime-mode');
  const mode: RuntimeMode =
    raw === 'test' || raw === 'live' ? raw : DEFAULT_RUNTIME_MODE;
  // Echo the resolved mode so the admin UI can confirm what backend
  // saw — debug aid when a tab swap appears to fail.
  res.setHeader('X-Runtime-Mode', mode);
  runWithMode(mode, () => next());
};
