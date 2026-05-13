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
import { generalLimiter } from './middleware/rateLimiter';
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

  const allowedOrigins = env.CLIENT_URL.split(',').map((s) => s.trim());
  // In non-production we additionally allow any `http://localhost:<port>` /
  // `http://127.0.0.1:<port>` so Flutter web dev builds (which pick a random
  // port on each `flutter run -d chrome` launch) don't need every port baked
  // into CLIENT_URL. Production stays strict — only the explicit list in
  // CLIENT_URL is accepted.
  const isLocalhostOrigin = (origin: string): boolean =>
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);
        if (env.NODE_ENV !== 'production' && isLocalhostOrigin(origin)) {
          return cb(null, true);
        }
        return cb(new Error('CORS: origin not allowed'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Signature',
        'X-Timestamp',
        'X-Nonce',
      ],
      maxAge: 86400,
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '100kb', strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '100kb', parameterLimit: 50 }));
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

  app.use(generalLimiter);

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
