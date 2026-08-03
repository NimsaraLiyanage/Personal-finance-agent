// Calendar-month windows for the summary statement.
//
// A month here is the user's calendar month, not a UTC one — a 31st-at-11pm
// transaction in Colombo belongs to that month, and computing the boundary in
// UTC would file it under the next one.

import { formatDateInZone, zonedToUtc } from '../agent/time';

export interface MonthWindow {
  /** `YYYY-MM`, the value that round-trips through the query string. */
  key: string;
  /** "August 2026" */
  label: string;
  from: Date;
  to: Date;
  previousKey: string;
  /** Null when the next month has not started yet — no forward link into an empty future. */
  nextKey: string | null;
}

const KEY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

function keyOf(year: number, month: number): string {
  // Month may be 0 or 13 after stepping; normalise through Date's own rollover.
  const normalised = new Date(Date.UTC(year, month - 1, 1));
  return `${normalised.getUTCFullYear()}-${String(normalised.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Resolve `?month=YYYY-MM` into a window, falling back to the current month for
 * anything missing or malformed rather than erroring on a hand-edited URL.
 */
export function resolveMonth(
  value: string | undefined | null,
  now: Date,
  timezone: string,
): MonthWindow {
  const currentKey = formatDateInZone(now, timezone).slice(0, 7);
  const match = value ? KEY_PATTERN.exec(value) : null;
  const key = match ? value! : currentKey;

  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));

  const from = zonedToUtc(timezone, year, month, 1);
  const to = zonedToUtc(timezone, year, month + 1, 1);
  const nextKey = keyOf(year, month + 1);

  return {
    key,
    label: new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: timezone,
    }).format(from),
    from,
    to,
    previousKey: keyOf(year, month - 1),
    nextKey: nextKey > currentKey ? null : nextKey,
  };
}
