'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { DASHBOARD_PERIODS, type DashboardPeriod } from '@/lib/finance/periods';

// The period lives in the URL, not in state: a view someone is looking at
// should be a link they can send, bookmark, or reload back into.
export default function PeriodTabs({ current }: { current: DashboardPeriod }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const select = (period: DashboardPeriod) => {
    const next = new URLSearchParams(params.toString());
    next.set('period', period);
    startTransition(() => router.push(`${pathname}?${next}`, { scroll: false }));
  };

  return (
    <div
      role="radiogroup"
      aria-label="Reporting period"
      className={`flex flex-wrap gap-0.5 rounded-full border border-line bg-surface-2 p-0.5 text-xs transition-opacity ${
        pending ? 'opacity-60' : ''
      }`}
    >
      {DASHBOARD_PERIODS.map((period) => {
        const active = period.key === current;
        return (
          <button
            key={period.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => select(period.key)}
            className={`rounded-full px-3 py-1.5 font-medium transition-colors ${
              active ? 'bg-surface text-ink shadow-raised' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            {period.label}
          </button>
        );
      })}
    </div>
  );
}
