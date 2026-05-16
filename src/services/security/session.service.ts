import crypto from 'crypto';
import { Request } from 'express';
import { UserSession, IUserSession } from '../../models/UserSession';
import { SecurityEvent, SecurityEventType, SecuritySeverity } from '../../models/SecurityEvent';
import { User } from '../../models/User';
import { Notification } from '../../models/Notification';
import { hash } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { lookupGeo } from './geoip.service';
import mongoose from 'mongoose';

const SESSION_TTL_DAYS = 30;
const INACTIVITY_LOGOUT_DAYS = 14;
// Earth circumference ~40075 km. 900 km/h ~ commercial jet. Anything
// faster than ~1100 km/h is "impossible travel" — we flag the session.
const IMPOSSIBLE_TRAVEL_KMH = 1100;

const headerVal = (val: unknown): string | undefined => {
  if (Array.isArray(val)) return val[0];
  if (typeof val === 'string') return val;
  return undefined;
};

export const extractDeviceFingerprint = (req: Request): string => {
  const ua = headerVal(req.headers['user-agent']) ?? '';
  const lang = headerVal(req.headers['accept-language']) ?? '';
  const platform = headerVal(req.headers['x-device-platform']) ?? '';
  const deviceId = headerVal(req.headers['x-device-id']) ?? '';
  // x-device-id (sent by Flutter via SharedPreferences-installed uuid)
  // is the strongest signal; the others are a fallback for callers who
  // haven't been updated yet.
  return hash(`${deviceId}|${platform}|${ua}|${lang}`);
};

const haversineKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const logSecurityEvent = async (
  user: string | mongoose.Types.ObjectId,
  type: SecurityEventType,
  severity: SecuritySeverity,
  req: Request,
  meta?: Record<string, unknown>,
): Promise<void> => {
  try {
    await SecurityEvent.create({
      user,
      type,
      severity,
      ip: req.ip,
      userAgent: headerVal(req.headers['user-agent']),
      deviceFingerprint: extractDeviceFingerprint(req),
      metadata: meta,
    });
  } catch (err) {
    logger.warn(`[security] event log failed: ${(err as Error).message}`);
  }
};

// Declared above `createSession` so the geo-IP wired login flow can
// call it without a forward reference. Compares the new geo against
// the most recent prior session and flags speeds above commercial-jet
// velocity (1100 km/h).
export const detectImpossibleTravel = async (
  userId: string | mongoose.Types.ObjectId,
  newGeo: { lat: number; lon: number; country?: string },
  req: Request,
): Promise<boolean> => {
  const last = await UserSession.findOne({
    user: userId,
    'geo.lat': { $exists: true },
  }).sort({ createdAt: -1 });
  if (!last?.geo?.lat || !last.geo.lon || !last.createdAt) return false;
  const km = haversineKm(
    { lat: last.geo.lat, lon: last.geo.lon },
    { lat: newGeo.lat, lon: newGeo.lon },
  );
  const hours = Math.max(0.01, (Date.now() - last.createdAt.getTime()) / 3_600_000);
  const speed = km / hours;
  if (speed > IMPOSSIBLE_TRAVEL_KMH) {
    await logSecurityEvent(userId, 'impossible_travel', 'high', req, { km, hours, speed });
    return true;
  }
  return false;
};

interface CreateSessionInput {
  userId: string | mongoose.Types.ObjectId;
  refreshToken: string;
  req: Request;
}

export const createSession = async (input: CreateSessionInput): Promise<IUserSession> => {
  const fp = extractDeviceFingerprint(input.req);
  const ua = headerVal(input.req.headers['user-agent']);

  const user = await User.findById(input.userId).select(
    '+security.knownDeviceFingerprints +security.knownIps',
  );

  // First-time device? Flag it + notify the user.
  const isKnown =
    user?.security?.knownDeviceFingerprints?.includes(fp) ?? false;

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

    // In-app push so the user sees "New sign-in from <device>" the moment
    // they unlock the app. Email path is left to a follow-up wire-up
    // through services/notification/email.service.ts.
    await Notification.create({
      user: user._id,
      type: 'security',
      title: 'New sign-in detected',
      body: `A new device just signed in to your account. If this wasn't you, change your password immediately.`,
      data: { deviceFingerprint: fp, ip: input.req.ip ?? null },
    }).catch(() => undefined);
  }

  // Resolve geo before creating the session so the row carries lat/lon
  // for impossible-travel detection. The lookup is cached in Redis for
  // 7 days per IP, so a returning user pays the live HTTP call once.
  const geo = (await lookupGeo(input.req.ip)) ?? undefined;

  // Impossible-travel guard runs on every login: if the previous
  // session's geo coordinates and the new one's are too far apart
  // for the elapsed time, log a `high` security event. Doesn't block
  // the login — the event surfaces in the admin Security panel.
  if (geo?.lat !== undefined && geo?.lon !== undefined) {
    await detectImpossibleTravel(
      input.userId,
      { lat: geo.lat, lon: geo.lon, country: geo.country },
      input.req,
    );
  }

  const session = await UserSession.create({
    user: input.userId,
    refreshTokenHash: hash(input.refreshToken),
    deviceFingerprint: fp,
    platform: (headerVal(input.req.headers['x-device-platform']) ?? 'unknown') as
      | 'android'
      | 'ios'
      | 'web'
      | 'admin_web'
      | 'unknown',
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

export const touchSession = async (refreshToken: string): Promise<void> => {
  await UserSession.updateOne(
    { refreshTokenHash: hash(refreshToken), revokedAt: { $exists: false } },
    { $set: { lastActivityAt: new Date() } },
  );
};

export const revokeSession = async (
  userId: string | mongoose.Types.ObjectId,
  sessionId: string,
  reason = 'user_revoke',
): Promise<void> => {
  await UserSession.updateOne(
    { _id: sessionId, user: userId },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
};

export const revokeAllSessions = async (
  userId: string | mongoose.Types.ObjectId,
  reason = 'logout_all',
): Promise<void> => {
  await UserSession.updateMany(
    { user: userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
};

export const listActiveSessions = async (
  userId: string | mongoose.Types.ObjectId,
): Promise<Record<string, unknown>[]> => {
  return UserSession.find({
    user: userId,
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  })
    .sort({ lastActivityAt: -1 })
    .lean();
};

export const sweepInactiveSessions = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - INACTIVITY_LOGOUT_DAYS * 24 * 60 * 60 * 1000);
  const res = await UserSession.updateMany(
    { lastActivityAt: { $lt: cutoff }, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date(), revokedReason: 'inactivity' } },
  );
  return res.modifiedCount ?? 0;
};

export { logSecurityEvent };
