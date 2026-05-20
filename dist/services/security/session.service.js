"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logSecurityEvent = exports.sweepInactiveSessions = exports.listActiveSessions = exports.revokeAllSessions = exports.revokeSession = exports.touchSession = exports.createSession = exports.detectImpossibleTravel = exports.extractDeviceFingerprint = void 0;
const UserSession_1 = require("../../models/UserSession");
const SecurityEvent_1 = require("../../models/SecurityEvent");
const User_1 = require("../../models/User");
const Notification_1 = require("../../models/Notification");
const crypto_1 = require("../../utils/crypto");
const logger_1 = require("../../utils/logger");
const geoip_service_1 = require("./geoip.service");
const SESSION_TTL_DAYS = 30;
const INACTIVITY_LOGOUT_DAYS = 14;
const IMPOSSIBLE_TRAVEL_KMH = 1100;
const headerVal = (val) => {
    if (Array.isArray(val))
        return val[0];
    if (typeof val === 'string')
        return val;
    return undefined;
};
const extractDeviceFingerprint = (req) => {
    const ua = headerVal(req.headers['user-agent']) ?? '';
    const lang = headerVal(req.headers['accept-language']) ?? '';
    const platform = headerVal(req.headers['x-device-platform']) ?? '';
    const deviceId = headerVal(req.headers['x-device-id']) ?? '';
    return (0, crypto_1.hash)(`${deviceId}|${platform}|${ua}|${lang}`);
};
exports.extractDeviceFingerprint = extractDeviceFingerprint;
const haversineKm = (a, b) => {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
};
const logSecurityEvent = async (user, type, severity, req, meta) => {
    try {
        await SecurityEvent_1.SecurityEvent.create({
            user,
            type,
            severity,
            ip: req.ip,
            userAgent: headerVal(req.headers['user-agent']),
            deviceFingerprint: (0, exports.extractDeviceFingerprint)(req),
            metadata: meta,
        });
    }
    catch (err) {
        logger_1.logger.warn(`[security] event log failed: ${err.message}`);
    }
};
exports.logSecurityEvent = logSecurityEvent;
const detectImpossibleTravel = async (userId, newGeo, req) => {
    const last = await UserSession_1.UserSession.findOne({
        user: userId,
        'geo.lat': { $exists: true },
    }).sort({ createdAt: -1 });
    if (!last?.geo?.lat || !last.geo.lon || !last.createdAt)
        return false;
    const km = haversineKm({ lat: last.geo.lat, lon: last.geo.lon }, { lat: newGeo.lat, lon: newGeo.lon });
    const hours = Math.max(0.01, (Date.now() - last.createdAt.getTime()) / 3_600_000);
    const speed = km / hours;
    if (speed > IMPOSSIBLE_TRAVEL_KMH) {
        await logSecurityEvent(userId, 'impossible_travel', 'high', req, { km, hours, speed });
        return true;
    }
    return false;
};
exports.detectImpossibleTravel = detectImpossibleTravel;
const createSession = async (input) => {
    const fp = (0, exports.extractDeviceFingerprint)(input.req);
    const ua = headerVal(input.req.headers['user-agent']);
    const user = await User_1.User.findById(input.userId).select('+security.knownDeviceFingerprints +security.knownIps');
    const isKnown = user?.security?.knownDeviceFingerprints?.includes(fp) ?? false;
    if (user && !isKnown) {
        await logSecurityEvent(user._id, 'new_device_login', 'medium', input.req, { fp });
        user.security.knownDeviceFingerprints = [
            ...(user.security.knownDeviceFingerprints ?? []),
            fp,
        ].slice(-10);
        if (input.req.ip) {
            user.security.knownIps = [...(user.security.knownIps ?? []), input.req.ip].slice(-20);
            user.security.lastSeenIp = input.req.ip;
        }
        await user.save();
        await Notification_1.Notification.create({
            user: user._id,
            type: 'security',
            title: 'New sign-in detected',
            body: `A new device just signed in to your account. If this wasn't you, change your password immediately.`,
            data: { deviceFingerprint: fp, ip: input.req.ip ?? null },
        }).catch(() => undefined);
    }
    const geo = (await (0, geoip_service_1.lookupGeo)(input.req.ip)) ?? undefined;
    if (geo?.lat !== undefined && geo?.lon !== undefined) {
        await (0, exports.detectImpossibleTravel)(input.userId, { lat: geo.lat, lon: geo.lon, country: geo.country }, input.req);
    }
    const session = await UserSession_1.UserSession.create({
        user: input.userId,
        refreshTokenHash: (0, crypto_1.hash)(input.refreshToken),
        deviceFingerprint: fp,
        platform: (headerVal(input.req.headers['x-device-platform']) ?? 'unknown'),
        appVersion: headerVal(input.req.headers['x-app-version']),
        ip: input.req.ip,
        userAgent: ua,
        geo,
        trusted: isKnown,
        lastActivityAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
    });
    return session;
};
exports.createSession = createSession;
const touchSession = async (refreshToken) => {
    await UserSession_1.UserSession.updateOne({ refreshTokenHash: (0, crypto_1.hash)(refreshToken), revokedAt: { $exists: false } }, { $set: { lastActivityAt: new Date() } });
};
exports.touchSession = touchSession;
const revokeSession = async (userId, sessionId, reason = 'user_revoke') => {
    await UserSession_1.UserSession.updateOne({ _id: sessionId, user: userId }, { $set: { revokedAt: new Date(), revokedReason: reason } });
};
exports.revokeSession = revokeSession;
const revokeAllSessions = async (userId, reason = 'logout_all') => {
    await UserSession_1.UserSession.updateMany({ user: userId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokedReason: reason } });
};
exports.revokeAllSessions = revokeAllSessions;
const listActiveSessions = async (userId) => {
    return UserSession_1.UserSession.find({
        user: userId,
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
    })
        .sort({ lastActivityAt: -1 })
        .lean();
};
exports.listActiveSessions = listActiveSessions;
const sweepInactiveSessions = async () => {
    const cutoff = new Date(Date.now() - INACTIVITY_LOGOUT_DAYS * 24 * 60 * 60 * 1000);
    const res = await UserSession_1.UserSession.updateMany({ lastActivityAt: { $lt: cutoff }, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokedReason: 'inactivity' } });
    return res.modifiedCount ?? 0;
};
exports.sweepInactiveSessions = sweepInactiveSessions;
