"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const morgan_1 = __importDefault(require("morgan"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const passport_1 = __importDefault(require("passport"));
const env_1 = require("./config/env");
const constants_1 = require("./config/constants");
const passport_2 = require("./config/passport");
const routes_1 = __importDefault(require("./routes"));
const errorHandler_1 = require("./middleware/errorHandler");
const rateLimiter_1 = require("./middleware/rateLimiter");
const sanitize_1 = require("./middleware/sanitize");
const security_1 = require("./middleware/security");
const logger_1 = require("./utils/logger");
const createApp = () => {
    const app = (0, express_1.default)();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.set('etag', false);
    app.use((0, helmet_1.default)({
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
    }));
    app.use(security_1.securityHeaders);
    const allowedOrigins = env_1.env.CLIENT_URL.split(',').map((s) => s.trim());
    app.use((0, cors_1.default)({
        origin: (origin, cb) => {
            if (!origin || allowedOrigins.includes(origin))
                return cb(null, true);
            return cb(new Error('CORS: origin not allowed'));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'X-Signature',
            'X-Timestamp',
            'X-Nonce',
        ],
        maxAge: 86400,
    }));
    app.use((0, compression_1.default)());
    app.use(express_1.default.json({ limit: '100kb', strict: true }));
    app.use(express_1.default.urlencoded({ extended: false, limit: '100kb', parameterLimit: 50 }));
    app.use((0, cookie_parser_1.default)(env_1.env.JWT_SECRET));
    app.use(sanitize_1.sanitizeRequest);
    app.use(security_1.detectSuspiciousActivity);
    app.use(security_1.slowDownAfterFailures);
    if (env_1.env.NODE_ENV !== 'test') {
        app.use((0, morgan_1.default)(env_1.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
            stream: { write: (msg) => logger_1.logger.info(msg.trim()) },
            skip: (req) => req.url === '/' || req.url.endsWith('/health'),
        }));
    }
    (0, passport_2.initPassport)();
    app.use(passport_1.default.initialize());
    app.use(rateLimiter_1.generalLimiter);
    app.get('/', (_req, res) => {
        res.json({
            success: true,
            service: 'Job Hunter Backend',
            version: '1.0.0',
            docs: `/api/${constants_1.API_VERSION}/health`,
        });
    });
    app.use(`/api/${constants_1.API_VERSION}`, routes_1.default);
    app.use(errorHandler_1.notFoundHandler);
    app.use(errorHandler_1.errorHandler);
    return app;
};
exports.createApp = createApp;
