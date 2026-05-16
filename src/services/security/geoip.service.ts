import axios from 'axios';
import { redis } from '../../config/redis';
import { logger } from '../../utils/logger';

export interface GeoLookup {
  country?: string;
  region?: string;
  city?: string;
  lat?: number;
  lon?: number;
}

const CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days — geo-IP is stable enough
const LOOKUP_TIMEOUT_MS = 1500;

// ip-api.com free tier (no key, 45 req/min). Sufficient for login/refresh
// volume because Redis caches the result per IP for a week. When the
// caller swaps to a paid provider (ipinfo, maxmind) just replace the
// `fetch` body — the cache wrapper and key format stay the same.
const isPrivateIp = (ip: string): boolean => {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  // 172.16.0.0/12
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
};

const cacheKey = (ip: string): string => `geoip:${ip}`;

const fetchFromProvider = async (ip: string): Promise<GeoLookup | null> => {
  try {
    const res = await axios.get(`http://ip-api.com/json/${encodeURIComponent(ip)}`, {
      timeout: LOOKUP_TIMEOUT_MS,
      params: { fields: 'status,country,regionName,city,lat,lon' },
    });
    if (res.data?.status !== 'success') return null;
    return {
      country: res.data.country,
      region: res.data.regionName,
      city: res.data.city,
      lat: typeof res.data.lat === 'number' ? res.data.lat : undefined,
      lon: typeof res.data.lon === 'number' ? res.data.lon : undefined,
    };
  } catch (err) {
    logger.warn(`[geoip] lookup failed for ${ip}: ${(err as Error).message}`);
    return null;
  }
};

export const lookupGeo = async (ip?: string): Promise<GeoLookup | null> => {
  if (!ip || isPrivateIp(ip)) return null;
  try {
    const cached = await redis.get(cacheKey(ip));
    if (cached) return JSON.parse(cached) as GeoLookup;
  } catch {
    // Redis flake — fall through to live lookup.
  }
  const live = await fetchFromProvider(ip);
  if (live) {
    try {
      await redis.set(cacheKey(ip), JSON.stringify(live), 'EX', CACHE_TTL_SEC);
    } catch {
      // Cache write failure is non-fatal.
    }
  }
  return live;
};
