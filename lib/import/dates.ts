// Date primitives shared by the two importers.
//
// The SMS parser hunts for a date inside a sentence; the CSV parser is handed a
// cell and asked what day it is. Different jobs, same conventions — and the
// conventions are the part that must not drift between them, because a ledger
// where one importer reads 03/08 as August and the other as March is worse than
// one that cannot import at all.
//
// **Day-first.** `03/08/2026` is the third of August. That is what it means
// everywhere these files and messages come from. Month-first is used only when
// the numbers force it: `08/23/2026` cannot have a 23rd month.
//
// Pure, like everything else in this folder — no clock, no locale, no database.

export const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export const MONTH_WORD = Object.keys(MONTH_NAMES).join('|');

export function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Two digits mean this century. Banks do not send statements about 1926. */
export function expandYear(value: number): number {
  return value < 100 ? 2000 + value : value;
}

/**
 * Read a single cell as a calendar date.
 *
 * Accepts what statements actually contain: `2026-08-03`, `03/08/2026`,
 * `3-8-26`, `03 Aug 2026`, `Aug 3, 2026`, and the same with a time trailing
 * after it. Returns null rather than guessing — an unparseable date must
 * surface in review, not silently become today.
 */
export function parseDateCell(value: string, todayIso: string): string | null {
  const text = value.trim();
  if (!text) return null;

  // ISO first: unambiguous, so nothing else gets a chance at it.
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number);
    return isRealDate(y, m, d) ? iso(y, m, d) : null;
  }

  // 03/08/2026 · 3-8-26 · 03.08.2026
  const numeric = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/.exec(text);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = expandYear(Number(numeric[3]));
    // Only a value above 12 can settle the order. Otherwise: day first.
    const [day, month] = a > 12 || b <= 12 ? [a, b] : [b, a];
    return isRealDate(year, month, day) ? iso(year, month, day) : null;
  }

  // 03 Aug 2026 · 3rd August 2026
  const dayMonth = new RegExp(
    String.raw`^(\d{1,2})(?:st|nd|rd|th)?[\s\-/]*(${MONTH_WORD})[a-z]*\.?[\s\-/,]*(\d{2,4})?`,
    'i',
  ).exec(text);
  if (dayMonth) {
    return withYear(
      MONTH_NAMES[dayMonth[2].toLowerCase()],
      Number(dayMonth[1]),
      dayMonth[3] ? expandYear(Number(dayMonth[3])) : null,
      todayIso,
    );
  }

  // Aug 03, 2026
  const monthDay = new RegExp(
    String.raw`^(${MONTH_WORD})[a-z]*\.?[\s\-/]+(\d{1,2})(?:st|nd|rd|th)?[\s\-/,]*(\d{2,4})?`,
    'i',
  ).exec(text);
  if (monthDay) {
    return withYear(
      MONTH_NAMES[monthDay[1].toLowerCase()],
      Number(monthDay[2]),
      monthDay[3] ? expandYear(Number(monthDay[3])) : null,
      todayIso,
    );
  }

  return null;
}

/**
 * A date with no year means this year — unless that lands in the future, in
 * which case it means last year. A December row read in January is the common
 * case and it must not date itself eleven months ahead.
 */
export function withYear(
  month: number,
  day: number,
  statedYear: number | null,
  todayIso: string,
): string | null {
  const [currentYear] = todayIso.split('-').map(Number);
  const todayMonthDay = Number(todayIso.slice(5, 7)) * 100 + Number(todayIso.slice(8, 10));
  const year = statedYear ?? (month * 100 + day > todayMonthDay ? currentYear - 1 : currentYear);
  return isRealDate(year, month, day) ? iso(year, month, day) : null;
}
