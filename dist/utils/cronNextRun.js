"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextRunFromExpression = void 0;
const nextRunFromExpression = (expression, fromUtc = new Date()) => {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5)
        return null;
    const fields = [
        parseField(parts[0], 0, 59),
        parseField(parts[1], 0, 23),
        parseField(parts[2], 1, 31),
        parseField(parts[3], 1, 12),
        parseField(parts[4], 0, 6),
    ];
    if (fields.some((f) => f === null))
        return null;
    const [minutes, hours, dom, months, dow] = fields;
    const candidate = new Date(fromUtc.getTime() + 60_000);
    candidate.setUTCSeconds(0, 0);
    const horizon = new Date(fromUtc.getTime() + 366 * 24 * 60 * 60 * 1000);
    while (candidate <= horizon) {
        if (minutes.has(candidate.getUTCMinutes()) &&
            hours.has(candidate.getUTCHours()) &&
            dom.has(candidate.getUTCDate()) &&
            months.has(candidate.getUTCMonth() + 1) &&
            dow.has(candidate.getUTCDay())) {
            return new Date(candidate);
        }
        candidate.setTime(candidate.getTime() + 60_000);
    }
    return null;
};
exports.nextRunFromExpression = nextRunFromExpression;
const parseField = (raw, min, max) => {
    if (raw === '*') {
        return rangeSet(min, max, 1);
    }
    if (raw.startsWith('*/')) {
        const step = parseInt(raw.slice(2), 10);
        if (!Number.isFinite(step) || step <= 0)
            return null;
        return rangeSet(min, max, step);
    }
    const values = new Set();
    for (const piece of raw.split(',')) {
        const n = parseInt(piece, 10);
        if (!Number.isFinite(n) || n < min || n > max)
            return null;
        values.add(n);
    }
    return values.size > 0 ? values : null;
};
const rangeSet = (min, max, step) => {
    const set = new Set();
    for (let i = min; i <= max; i += step)
        set.add(i);
    return set;
};
