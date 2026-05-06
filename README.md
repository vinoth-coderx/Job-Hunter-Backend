# Job Hunter Backend

Production-ready Node.js + TypeScript backend that aggregates jobs from **Adzuna**, **SerpApi (Google Jobs)**, **RapidAPI (JSearch)**, and **Puppeteer** (Indeed). Caches in Redis, persists in MongoDB, and serves AI-matched jobs to authenticated users with subscription tiers.

## Features

- **Multi-source job scraping** — Adzuna, SerpApi, RapidAPI/JSearch, plus Puppeteer fallback for Indeed
- **Hourly cron** — Auto-fetches the last 10 days of jobs, upserts to MongoDB, invalidates Redis cache
- **Redis caching** — Job lists, single jobs, and per-user matches cached with TTL
- **Auth** — Email/password (bcrypt + JWT) **and** Google OAuth 2.0
- **AI profile matching** — Anthropic Claude scores candidate-job fit (0-100); falls back to fast heuristic matcher; serves only `>= 80%` matches by default
- **Subscription tiers** — Free, Weekly, Monthly, Yearly with feature gating
- **Applied jobs tracker** — Status, notes, follow-ups
- **Production middleware** — Helmet, CORS, compression, rate-limit, structured Winston logging, central error handler

## Quick start

```bash
# 1. Install
npm install

# 2. Configure env
cp .env.example .env
# Fill in MONGODB_URI, JWT_SECRET, JWT_REFRESH_SECRET (required)
# Add API keys for whichever sources you want active

# 3. Make sure MongoDB + Redis are running locally
# (or point env at hosted services)

# 4. Run
npm run dev          # development with hot reload
npm run build        # compile TS -> dist/
npm start            # run compiled
```

## Required env vars (minimum)

```
MONGODB_URI=mongodb://localhost:27017/job_hunter
JWT_SECRET=<32+ char random string>
JWT_REFRESH_SECRET=<32+ char random string>
```

Everything else is optional. Each scraper and Google login self-disable if their keys are missing.

## API endpoints

Base: `http://localhost:5000/api/v1`

### Auth
- `POST /auth/register` — `{ email, password, fullName }`
- `POST /auth/login` — `{ email, password }`
- `POST /auth/refresh` — `{ refreshToken }`
- `POST /auth/logout` (auth)
- `GET  /auth/me` (auth)
- `GET  /auth/google` — start Google OAuth
- `GET  /auth/google/callback` — OAuth callback

### Users
- `PATCH /users/profile` (auth) — Update profile (skills, preferred roles/locations, resume text, etc.)
- `POST  /users/change-password` (auth)
- `DELETE /users/account` (auth)

### Jobs
- `GET /jobs` — Public list with search/filter: `?q=&location=&skills=react,node&jobType=full-time&remoteType=remote&minSalary=500000&page=1&limit=20`
- `GET /jobs/:id` — Job detail
- `GET /jobs/matched` (auth) — AI-matched jobs for the user (>= 80% match by default). Add `?ai=true` for Claude-powered matching, `?threshold=70` to lower bar
- `POST /jobs/admin/fetch` (admin) — Manually trigger scraper

### Applied
- `GET /applied` (auth) — List user's applied jobs
- `GET /applied/stats` (auth) — Application stats by status
- `POST /applied` (auth) — `{ jobId, notes }`
- `PATCH /applied/:id` (auth) — Update status/notes/follow-up
- `DELETE /applied/:id` (auth)

### Subscriptions
- `GET  /subscriptions/plans` — All plans (free/weekly/monthly/yearly)
- `GET  /subscriptions/current` (auth)
- `GET  /subscriptions/history` (auth)
- `POST /subscriptions/subscribe` (auth) — `{ tier, paymentMethod, paymentId, orderId }`
- `POST /subscriptions/cancel` (auth)

## Architecture

```
src/
├── index.ts                    # Entry — boots DB, Redis, server, cron
├── app.ts                      # Express setup + middleware
├── config/
│   ├── env.ts                  # Zod-validated env config
│   ├── database.ts             # MongoDB
│   ├── redis.ts                # ioredis client + cache keys
│   └── passport.ts             # Google OAuth strategy
├── models/                     # Mongoose schemas: User, Job, AppliedJob, Subscription
├── middleware/                 # auth, errorHandler, rateLimiter, subscription, validate
├── routes/                     # Express routers
├── controllers/                # Route handlers
├── services/
│   ├── scrapers/               # Adzuna, SerpApi, RapidAPI, Puppeteer + index aggregator
│   └── ai/matcher.service.ts   # Claude + heuristic match scoring
├── jobs/jobScraper.cron.ts     # node-cron: hourly fetch + daily sub expiry
├── utils/                      # logger, jwt, ApiError, asyncHandler
└── types/                      # Shared TS types
```

## How matching works

1. User updates profile with skills, preferred roles, locations, etc.
2. `GET /jobs/matched` pulls fresh jobs (≤ 10 days, active) that overlap with user skills/roles.
3. Each candidate is scored by either:
   - **Heuristic** (default, fast, free) — skill overlap + role/location/jobType signals.
   - **AI** (`?ai=true`) — Claude Haiku 4.5 scores 0-100 with reasoning, cached for 24h per user-job.
4. Only jobs scoring `>= AI_MATCH_THRESHOLD` (default 80) are returned, sorted by score.

## Scraping config

- `CRON_JOB_FETCH_SCHEDULE=0 * * * *` — Every hour at minute 0.
- `JOB_FRESHNESS_DAYS=10` — Only keeps and serves jobs ≤ 10 days old.
- Each fetch runs across a default matrix of queries × locations (configurable in `services/scrapers/index.ts`).
- Failed sources don't block the others (`Promise.allSettled`).
- Stale jobs (>10 days) are marked `isActive: false` and excluded from queries.

## Subscription tiers

| Tier    | Price   | Duration | Match Limit | Features                                    |
| ------- | ------- | -------- | ----------- | ------------------------------------------- |
| Free    | ₹0      | ∞        | 5/day       | Basic search                                |
| Weekly  | ₹99     | 7d       | 100         | Unlimited matches, AI matching, priority    |
| Monthly | ₹299    | 30d      | 500         | + advanced filters, resume insights         |
| Yearly  | ₹2,499  | 365d     | 10,000      | + dedicated support (best value)            |

Plans live in `src/models/Subscription.ts` (`SUBSCRIPTION_PLANS`) — edit there.

## Where to get API keys

- **Adzuna** — https://developer.adzuna.com/ (free tier, register app)
- **SerpApi** — https://serpapi.com/ (100 free searches/mo)
- **RapidAPI / JSearch** — https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
- **Google OAuth** — https://console.cloud.google.com/apis/credentials → OAuth 2.0 Client ID. Add redirect: `http://localhost:5000/api/v1/auth/google/callback`
- **Anthropic** — https://console.anthropic.com/ (for AI matching, optional)
- **Razorpay** — https://dashboard.razorpay.com/ (subscription payments, optional)

## Security hardening

API endpoints are protected against the most common attack vectors:

- **Helmet with strict CSP** — defaults plus `frameguard: deny`, HSTS preload, no-sniff, COOP/CORP, Permissions-Policy locking down camera/mic/geo
- **Custom security headers** — `X-Powered-By` and `Server` removed; explicit `Referrer-Policy`, `X-Frame-Options`, `X-Content-Type-Options`
- **CORS allowlist** — Only `CLIENT_URL` origins (comma-separated) accepted; rejects unknown origins with explicit error
- **NoSQL injection sanitization** — Strips any keys starting with `$` or containing `.` from `req.body`, `req.query`, `req.params` (blocks `{ $ne, $gt, $where }` injection in MongoDB queries)
- **Suspicious activity detection** — Pattern-based block on common SQLi, XSS, path-traversal, and Mongo operator payloads in URL/body
- **Strong password policy** — 8+ chars, uppercase, lowercase, number, special char; bcrypt with cost 12
- **Brute-force lockout** — 6 failed login attempts per `email+IP` within 15 min → account locked for 30 min (Redis-backed)
- **Adaptive slow-down** — Repeat offenders get progressive delays (up to 2s) before request handling
- **JWT short-lived access + rotating refresh** — Refresh tokens stored hashed in user doc, max 5 active per user, single-use rotation
- **Optional HMAC request signing** — `requireSignedRequest` middleware validates `X-Signature`, `X-Timestamp`, `X-Nonce` (HMAC-SHA256 over method + URL + ts + nonce + body), with 5-min freshness window and Redis nonce-replay protection. Apply to high-value routes (payments, admin):
  ```ts
  router.post('/payment', requireSignedRequest, controller.handle);
  ```
  Client signs with: `hmacSHA256(METHOD\nURL\nTIMESTAMP\nNONCE\nBODY, secret)`
- **AES-256-GCM at-rest encryption helper** — `encrypt()`/`decrypt()` in `utils/crypto.ts` for any sensitive fields you want to store encrypted
- **Constant-time comparison** — `constantTimeEqual()` for any token/secret matching to prevent timing attacks
- **Body size limits** — JSON capped at 100kb, parameter count at 50 to block payload-bomb DoS
- **Rate limiting** — Global 100 req/15min per IP; auth routes 10/15min; scrape routes 5/min
- **Production error responses** — Stack traces never leak in production; 500-class errors return generic "Internal server error" message
- **Bcrypt password hashing** — Cost 12 (run-time tunable), passwords excluded from queries by default (`select: false`)
- **Account lockout on lock** — Surfaces as `429 Too Many Requests` so attackers can't distinguish from generic rate-limit
- **Refresh-token list capped** — Max 5 active sessions per user (oldest evicted), allowing logout from all devices
- **Mongo Atlas TLS** — Use `mongodb+srv://` with TLS in production
- **Helmet HSTS preload** — 1-year HSTS once you're on HTTPS in production

## Production checklist

- Run `npm run build` and serve `dist/`
- Set `NODE_ENV=production`
- Use long random `JWT_SECRET` and `JWT_REFRESH_SECRET` (32+ chars)
- Use hosted MongoDB (Atlas) and Redis (Upstash, Redis Cloud)
- Set `CLIENT_URL` to your real frontend origin(s) (comma-separated)
- Reverse-proxy behind nginx/Caddy with HTTPS
- Adjust `RATE_LIMIT_*` for your traffic
- Monitor `logs/error.log` and `logs/combined.log`
# Job-Hunter-Backend
