import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Response, Request } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import {
  getRuntimeMode,
  setRuntimeMode,
  type RuntimeMode,
} from '../services/config/config.service';

/**
 * Pre-auth runtime-mode endpoints. Live on a separate path from the
 * admin-guarded `/admin/config/mode` because the login screen has no
 * JWT yet — the operator picks Test vs Live BEFORE entering credentials
 * so we know which mode's Mongo to authenticate against.
 *
 * Read is unauthenticated; flip is rate-limited (3/min/IP). When
 * `RUNTIME_MODE_SWITCH_TOKEN` is set in env, the flip also requires the
 * matching `X-Runtime-Mode-Token` header — recommended for any backend
 * exposed beyond a single trusted network.
 */
const router = Router();

const flipLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many mode flips. Try again in a minute.',
  },
});

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ mode: getRuntimeMode() });
  }),
);

router.put(
  '/',
  flipLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const requiredToken = process.env.RUNTIME_MODE_SWITCH_TOKEN;
    if (requiredToken) {
      const supplied = req.header('x-runtime-mode-token') ?? '';
      if (supplied !== requiredToken) {
        throw ApiError.unauthorized('Invalid mode-switch token');
      }
    }

    const raw = req.body?.mode;
    if (raw !== 'test' && raw !== 'live') {
      throw ApiError.badRequest("mode must be 'test' or 'live'");
    }
    const mode = raw as RuntimeMode;
    if (mode === getRuntimeMode()) {
      res.json({ mode, restarting: false });
      return;
    }
    setRuntimeMode(mode);
    logger.warn(`Pre-auth runtime-mode flip → ${mode} from ${req.ip}`);
    res.json({ mode, restarting: true });
    // Same restart pattern as the post-auth flip. The process manager
    // (nodemon / Render / pm2) brings the backend back with the new
    // mode's Mongo + Redis connections.
    setTimeout(() => {
      logger.warn('Exiting process for runtime-mode restart');
      process.exit(0);
    }, 500);
  }),
);

export default router;
