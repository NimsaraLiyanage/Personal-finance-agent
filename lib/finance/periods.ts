// The dashboard's period vocabulary.
//
// Kept in its own module with no database import so the client-side period
// switcher can share the exact list the server queries against — one place to
// add "last 90 days" rather than two that drift.

import type { PeriodKey } from '../agent/time';

export const DASHBOARD_PERIODS = [
  { key: 'this_week', label: 'This week' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'this_year', label: 'This year' },
] as const satisfies ReadonlyArray<{ key: PeriodKey; label: string }>;

export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]['key'];

export const DEFAULT_PERIOD: DashboardPeriod = 'this_month';

/** Anything unrecognised — a hand-edited query string — falls back rather than 500s. */
export function parsePeriod(value: string | undefined | null): DashboardPeriod {
  const match = DASHBOARD_PERIODS.find((p) => p.key === value);
  return match ? match.key : DEFAULT_PERIOD;
}

/** How the trend chart should bucket time for a given period. */
export function trendShapeFor(period: DashboardPeriod): {
  granularity: 'day' | 'week' | 'month';
  buckets: number;
  title: string;
} {
  switch (period) {
    case 'this_week':
      return { granularity: 'day', buckets: 7, title: 'Net flow by day' };
    case 'this_year':
      return { granularity: 'month', buckets: 12, title: 'Net flow by month' };
    default:
      return { granularity: 'month', buckets: 6, title: 'Net flow by month' };
  }
}
