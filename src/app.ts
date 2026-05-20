import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { API_VERSION } from './config/constants';
import routes from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createGeneralLimiter } from './middleware/rateLimiter';
import { runtimeModeFromHeader } from './middleware/runtimeMode';
import { sanitizeRequest } from './middleware/sanitize';
import {
  securityHeaders,
  detectSuspiciousActivity,
  slowDownAfterFailures,
} from './middleware/security';
import { logger } from './utils/logger';

export const createApp = (): Application => {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.set('etag', false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'https:', 'data:'],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      noSniff: true,
      frameguard: { action: 'deny' },
    }),
  );
  app.use(securityHeaders);

  const allowedOrigins = env.CLIENT_URL.split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter((s) => s.length > 0);
  // Localhost / LAN origins are always allowed — this backend is
  // primarily consumed by trusted internal clients (the admin
  // console, locally-run Flutter web builds, Android emulator on
  // 10.0.2.2) and the cost of "developer can't reach the deployed
  // backend from a localhost dashboard" is far higher than the
  // marginal risk of accepting Origin: http://localhost:3000 in
  // production (DNS rebinding is mitigated by JWT auth + the
  // explicit allowedHeaders below). Non-localhost cross-origin
  // requests still go through the strict CLIENT_URL allow-list.
  const isDevOrigin = (origin: string): boolean =>
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2|192\.168\.\d+\.\d+|172\.\d+\.\d+\.\d+)(:\d+)?$/.test(
      origin,
    );
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        const normalized = origin.replace(/\/$/, '');
        if (allowedOrigins.includes(normalized)) return cb(null, true);
        if (isDevOrigin(normalized)) return cb(null, true);
        // Log the actual blocked origin so the admin can diff against
        // their CLIENT_URL config when staring at a "Failed to fetch"
        // in the browser console.
        logger.warn(
          `CORS blocked: "${origin}" not in allowed list [${allowedOrigins.join(', ')}] (NODE_ENV=${env.NODE_ENV})`,
        );
        return cb(new Error(`CORS: origin "${origin}" not allowed`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Signature',
        'X-Timestamp',
        'X-Nonce',
        'X-Runtime-Mode',
      ],
      exposedHeaders: ['X-Runtime-Mode'],
      maxAge: 86400,
    }),
  );

  app.use(compression());
  // Resume template HTML uploads can run to ~200KB once styles are inline;
  // 300kb leaves headroom while staying small enough that a payload flood
  // is still cheap to reject. Other endpoints keep their existing zod
  // schemas (each enforces its own tighter per-field caps).
  app.use(express.json({ limit: '300kb', strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '300kb', parameterLimit: 50 }));
  app.use(cookieParser(env.JWT_SECRET));

  app.use(sanitizeRequest);
  app.use(detectSuspiciousActivity);
  app.use(slowDownAfterFailures);

  if (env.NODE_ENV !== 'test') {
    app.use(
      morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev', {
        stream: { write: (msg) => logger.info(msg.trim()) },
        skip: (req) => req.url === '/' || req.url.endsWith('/health'),
      }),
    );
  }

  // Per-request runtime-mode binding (AsyncLocalStorage). Reads the
  // X-Runtime-Mode header — admin UI sets it, Flutter doesn't, so
  // Flutter traffic safely defaults to `live`.
  app.use(runtimeModeFromHeader);

  app.use(createGeneralLimiter());

  app.get('/', (_req, res) => {
    res.json({
      success: true,
      service: 'Job Hunter Backend',
      version: '1.0.0',
      docs: `/api/${API_VERSION}/health`,
    });
  });

  app.use(`/api/${API_VERSION}`, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
