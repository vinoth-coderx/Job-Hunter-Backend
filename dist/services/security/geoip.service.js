"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.lookupGeo = void 0;
const axios_1 = __importDefault(require("axios"));
const redis_1 = require("../../config/redis");
const logger_1 = require("../../utils/logger");
const CACHE_TTL_SEC = 7 * 24 * 60 * 60;
const LOOKUP_TIMEOUT_MS = 1500;
const isPrivateIp = (ip) => {
    if (!ip)
        return true;
    if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.'))
        return true;
    if (ip.startsWith('10.') || ip.startsWith('192.168.'))
        return true;
    const m = /^172\.(\d+)\./.exec(ip);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31)
        return true;
    return false;
};
const cacheKey = (ip) => `geoip:${ip}`;
const fetchFromProvider = async (ip) => {
    try {
        const res = await axios_1.default.get(`http://ip-api.com/json/${encodeURIComponent(ip)}`, {
            timeout: LOOKUP_TIMEOUT_MS,
            params: { fields: 'status,country,regionName,city,lat,lon' },
        });
        if (res.data?.status !== 'success')
            return null;
        return {
            country: res.data.country,
            region: res.data.regionName,
            city: res.data.city,
            lat: typeof res.data.lat === 'number' ? res.data.lat : undefined,
            lon: typeof res.data.lon === 'number' ? res.data.lon : undefined,
        };
    }
    catch (err) {
        logger_1.logger.warn(`[geoip] lookup failed for ${ip}: ${err.message}`);
        return null;
    }
};
const lookupGeo = async (ip) => {
    if (!ip || isPrivateIp(ip))
        return null;
    try {
        const cached = await redis_1.redis.get(cacheKey(ip));
        if (cached)
            return JSON.parse(cached);
    }
    catch {
    }
    const live = await fetchFromProvider(ip);
    if (live) {
        try {
            await redis_1.redis.set(cacheKey(ip), JSON.stringify(live), 'EX', CACHE_TTL_SEC);
        }
        catch {
        }
    }
    return live;
};
exports.lookupGeo = lookupGeo;
