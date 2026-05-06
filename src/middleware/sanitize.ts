import { Request, Response, NextFunction } from 'express';

const FORBIDDEN_KEY_RE = /^\$|\./;

const stripDangerous = (val: unknown): unknown => {
  if (Array.isArray(val)) return val.map(stripDangerous);
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (FORBIDDEN_KEY_RE.test(k)) continue;
      out[k] = stripDangerous(v);
    }
    return out;
  }
  return val;
};

const stripQueryInPlace = (q: Record<string, unknown>): void => {
  for (const k of Object.keys(q)) {
    if (FORBIDDEN_KEY_RE.test(k)) {
      delete q[k];
      continue;
    }
    const v = q[k];
    if (v && typeof v === 'object') q[k] = stripDangerous(v);
  }
};

const stripParamsInPlace = (p: Record<string, unknown>): void => {
  for (const k of Object.keys(p)) {
    if (FORBIDDEN_KEY_RE.test(k)) delete p[k];
  }
};

export const sanitizeRequest = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.body && typeof req.body === 'object') {
    req.body = stripDangerous(req.body);
  }
  if (req.query) stripQueryInPlace(req.query as Record<string, unknown>);
  if (req.params) stripParamsInPlace(req.params as Record<string, unknown>);
  next();
};
