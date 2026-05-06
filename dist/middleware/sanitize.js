"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeRequest = void 0;
const FORBIDDEN_KEY_RE = /^\$|\./;
const stripDangerous = (val) => {
    if (Array.isArray(val))
        return val.map(stripDangerous);
    if (val && typeof val === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(val)) {
            if (FORBIDDEN_KEY_RE.test(k))
                continue;
            out[k] = stripDangerous(v);
        }
        return out;
    }
    return val;
};
const stripQueryInPlace = (q) => {
    for (const k of Object.keys(q)) {
        if (FORBIDDEN_KEY_RE.test(k)) {
            delete q[k];
            continue;
        }
        const v = q[k];
        if (v && typeof v === 'object')
            q[k] = stripDangerous(v);
    }
};
const stripParamsInPlace = (p) => {
    for (const k of Object.keys(p)) {
        if (FORBIDDEN_KEY_RE.test(k))
            delete p[k];
    }
};
const sanitizeRequest = (req, _res, next) => {
    if (req.body && typeof req.body === 'object') {
        req.body = stripDangerous(req.body);
    }
    if (req.query)
        stripQueryInPlace(req.query);
    if (req.params)
        stripParamsInPlace(req.params);
    next();
};
exports.sanitizeRequest = sanitizeRequest;
