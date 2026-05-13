/**
 * Minimal next-run computer for the cron expressions our backend uses.
 * Supports the subset we actually schedule: `*`, `* /N`, and exact integer
 * lists for the five fields (minute hour day-of-month month day-of-week).
 *
 * We don't pull in `cron-parser` because the only place we need this is
 * the admin dashboard's "next run in 18m" tile — a couple of expressions,
 * always parseable by the patterns above. Fail-soft: returns null on any
 * unsupported expression so the UI just renders "—" instead of crashing.
 */
export const nextRunFromExpression = (
  expression: string,
  fromUtc: Date = new Date(),
): Date | null => {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const fields = [
    parseField(parts[0], 0, 59), // minute
    parseField(parts[1], 0, 23), // hour
    parseField(parts[2], 1, 31), // day-of-month
    parseField(parts[3], 1, 12), // month (1-12)
    parseField(parts[4], 0, 6),  // day-of-week (0-6, Sun=0)
  ];
  if (fields.some((f) => f === null)) return null;
  const [minutes, hours, dom, months, dow] = fields as Set<number>[];

  // Walk minute-by-minute up to one year ahead. Bounded so a malformed
  // expression that nothing matches can't loop forever.
  const candidate = new Date(fromUtc.getTime() + 60_000);
  candidate.setUTCSeconds(0, 0);
  const horizon = new Date(fromUtc.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (candidate <= horizon) {
    if (
      minutes.has(candidate.getUTCMinutes()) &&
      hours.has(candidate.getUTCHours()) &&
      dom.has(candidate.getUTCDate()) &&
      months.has(candidate.getUTCMonth() + 1) &&
      dow.has(candidate.getUTCDay())
    ) {
      return new Date(candidate);
    }
    candidate.setTime(candidate.getTime() + 60_000);
  }
  return null;
};

const parseField = (
  raw: string,
  min: number,
  max: number,
): Set<number> | null => {
  if (raw === '*') {
    return rangeSet(min, max, 1);
  }
  // Step form: */N or M-N/S
  if (raw.startsWith('*/')) {
    const step = parseInt(raw.slice(2), 10);
    if (!Number.isFinite(step) || step <= 0) return null;
    return rangeSet(min, max, step);
  }
  // Comma-separated exact values: 0,15,30,45
  const values = new Set<number>();
  for (const piece of raw.split(',')) {
    const n = parseInt(piece, 10);
    if (!Number.isFinite(n) || n < min || n > max) return null;
    values.add(n);
  }
  return values.size > 0 ? values : null;
};

const rangeSet = (min: number, max: number, step: number): Set<number> => {
  const set = new Set<number>();
  for (let i = min; i <= max; i += step) set.add(i);
  return set;
};
