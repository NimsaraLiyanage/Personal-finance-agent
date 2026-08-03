// Timezone-correct date math with zero dependencies.
//
// Everything the agent asks for is a *calendar* question — "this month",
// "yesterday", "last week" — and calendars are local. Computing those in UTC
// puts late-evening transactions in the wrong day for anyone east of Greenwich
// and the wrong month twice a year. Postgres stores instants; this module is
// the only place that converts between an instant and a user's wall clock.
//
// Implementation note: `Intl.DateTimeFormat` is the only timezone database in
// the standard library, so offsets are derived from formatted parts rather
// than hardcoded. The two-pass correction in `zonedToUtc` handles DST
// transitions, where a naive single pass lands an hour off.

export type PeriodKey =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'last_30_days'
  | 'last_90_days'
  | 'this_year'
  | 'all_time';

interface Parts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    // `hour12: false` yields 24 for midnight in some ICU versions.
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Milliseconds to add to a UTC instant to get the zone's wall clock. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Zero out sub-second noise so the offset is a clean minute multiple.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** A wall-clock time in `timeZone` → the UTC instant it refers to. */
export function zonedToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Pass 1: subtract the offset observed at the guessed instant.
  const first = new Date(guess - offsetMs(new Date(guess), timeZone));
  // Pass 2: the offset may differ on the other side of a DST boundary.
  const second_ = new Date(guess - offsetMs(first, timeZone));
  return second_;
}

/** Resolve "now": the client's clock when supplied, else the server's. */
export function nowInZone(clientNow: string | undefined, _timeZone: string): Date {
  if (clientNow) {
    const parsed = new Date(clientNow);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** YYYY-MM-DD as seen in `timeZone`. */
export function formatDateInZone(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function startOfDay(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return zonedToUtc(timeZone, p.year, p.month, p.day);
}

export function addDays(date: Date, days: number, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return zonedToUtc(timeZone, p.year, p.month, p.day + days, p.hour, p.minute, p.second);
}

export function monthBounds(date: Date, timeZone: string): { start: Date; end: Date } {
  const p = zonedParts(date, timeZone);
  return {
    start: zonedToUtc(timeZone, p.year, p.month, 1),
    // Month 13 rolls over correctly through Date.UTC.
    end: zonedToUtc(timeZone, p.year, p.month + 1, 1),
  };
}

/** Week starts Monday — the convention almost everywhere outside the US. */
export function weekBounds(date: Date, timeZone: string): { start: Date; end: Date } {
  const dayOfWeek = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
      .format(date)
      .replace(/Sun/, '0')
      .replace(/Mon/, '1')
      .replace(/Tue/, '2')
      .replace(/Wed/, '3')
      .replace(/Thu/, '4')
      .replace(/Fri/, '5')
      .replace(/Sat/, '6'),
  );
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const start = startOfDay(addDays(date, -daysSinceMonday, timeZone), timeZone);
  const end = addDays(start, 7, timeZone);
  return { start, end };
}

export interface ResolvedPeriod {
  from: Date;
  to: Date;
  label: string;
  /** Same-length window immediately before `from`, for period-over-period. */
  previousFrom: Date | null;
  previousTo: Date | null;
}

export function resolvePeriod(period: PeriodKey, now: Date, timeZone: string): ResolvedPeriod {
  const withPrevious = (from: Date, to: Date, label: string): ResolvedPeriod => {
    const span = to.getTime() - from.getTime();
    return {
      from,
      to,
      label,
      previousFrom: new Date(from.getTime() - span),
      previousTo: from,
    };
  };

  switch (period) {
    case 'today': {
      const start = startOfDay(now, timeZone);
      return withPrevious(start, addDays(start, 1, timeZone), 'Today');
    }
    case 'yesterday': {
      const start = startOfDay(addDays(now, -1, timeZone), timeZone);
      return withPrevious(start, addDays(start, 1, timeZone), 'Yesterday');
    }
    case 'this_week': {
      const { start, end } = weekBounds(now, timeZone);
      return withPrevious(start, end, 'This week');
    }
    case 'last_week': {
      const { start } = weekBounds(now, timeZone);
      const from = addDays(start, -7, timeZone);
      return withPrevious(from, start, 'Last week');
    }
    case 'this_month': {
      const { start, end } = monthBounds(now, timeZone);
      const p = zonedParts(now, timeZone);
      return {
        from: start,
        to: end,
        label: 'This month',
        previousFrom: zonedToUtc(timeZone, p.year, p.month - 1, 1),
        previousTo: start,
      };
    }
    case 'last_month': {
      const p = zonedParts(now, timeZone);
      const from = zonedToUtc(timeZone, p.year, p.month - 1, 1);
      const to = zonedToUtc(timeZone, p.year, p.month, 1);
      return {
        from,
        to,
        label: 'Last month',
        previousFrom: zonedToUtc(timeZone, p.year, p.month - 2, 1),
        previousTo: from,
      };
    }
    case 'last_30_days': {
      const to = addDays(startOfDay(now, timeZone), 1, timeZone);
      return withPrevious(addDays(to, -30, timeZone), to, 'Last 30 days');
    }
    case 'last_90_days': {
      const to = addDays(startOfDay(now, timeZone), 1, timeZone);
      return withPrevious(addDays(to, -90, timeZone), to, 'Last 90 days');
    }
    case 'this_year': {
      const p = zonedParts(now, timeZone);
      const from = zonedToUtc(timeZone, p.year, 1, 1);
      return {
        from,
        to: zonedToUtc(timeZone, p.year + 1, 1, 1),
        label: String(p.year),
        previousFrom: zonedToUtc(timeZone, p.year - 1, 1, 1),
        previousTo: from,
      };
    }
    case 'all_time':
    default:
      return {
        from: new Date(0),
        to: addDays(startOfDay(now, timeZone), 1, timeZone),
        label: 'All time',
        previousFrom: null,
        previousTo: null,
      };
  }
}

/**
 * Parse the `occurred_on` a tool received. Accepts a bare calendar date
 * (interpreted at noon in the user's zone, so a later timezone correction can
 * never tip it into an adjacent day) or a full instant. Falls back to now.
 */
export function parseOccurredAt(
  value: string | undefined,
  now: Date,
  timeZone: string,
): Date {
  if (!value) return now;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnly) {
    return zonedToUtc(
      timeZone,
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
      12,
    );
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? now : parsed;
}
