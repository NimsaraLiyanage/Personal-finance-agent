'use client';

import { useState, useTransition } from 'react';

import { dismissRecurring, markRecurring, rescanRecurring } from '@/app/actions/recurring';
import type { RecurringView } from '@/lib/finance/recurring';

// What you have quietly committed to.
//
// The headline is the monthly total, not the list, because the list is only
// ever a few lines and the total is the number that lands: everything here is
// leaving your account whether or not you think about it this month.
//
// Two states earn their own colour, and only two. A price that moved, and a
// charge that stopped arriving — both are things that changed without anyone
// telling you, which is the only reason this panel exists.

const CADENCE_LABEL: Record<string, string> = {
  weekly: 'a week',
  monthly: 'a month',
  yearly: 'a year',
};

export default function RecurringPanel({
  items,
  formattedMonthlyTotal,
  activeCount,
}: {
  items: RecurringView[];
  formattedMonthlyTotal: string;
  activeCount: number;
}) {
  const [scan, setScan] = useState<{ message: string; tone: 'ok' | 'bad' } | null>(null);
  const [pending, startTransition] = useTransition();

  const rescan = () => {
    setScan(null);
    startTransition(async () => {
      const result = await rescanRecurring();
      if (!result.ok) {
        setScan({ message: result.error ?? 'Scan failed.', tone: 'bad' });
        return;
      }
      setScan({
        message:
          result.found === 0
            ? 'Nothing repeating yet — it takes three charges on a steady rhythm.'
            : `${result.found} repeating ${result.found === 1 ? 'charge' : 'charges'}${
                result.added ? `, ${result.added} new` : ''
              }.`,
        tone: 'ok',
      });
    });
  };

  return (
    <section className="card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">Repeating</h2>
        <button
          type="button"
          onClick={rescan}
          disabled={pending}
          className="text-xs text-accent transition-opacity hover:underline disabled:opacity-50"
        >
          {pending ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {activeCount > 0 && (
        <p className="mb-3 text-sm">
          <span className="text-lg font-semibold tabular-nums">{formattedMonthlyTotal}</span>
          <span className="text-ink-faint"> a month across {activeCount}</span>
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-sm leading-relaxed text-ink-faint">
          Nothing found yet. A charge counts once it has landed three times on a steady rhythm —
          then this is where the ones you forgot about show up.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id}>
              <Row item={item} />
            </li>
          ))}
        </ul>
      )}

      {scan && (
        <p
          role="status"
          className={`mt-3 text-[11px] leading-relaxed ${
            scan.tone === 'bad' ? 'text-danger' : 'text-ink-faint'
          }`}
        >
          {scan.message}
        </p>
      )}
    </section>
  );
}

function Row({ item }: { item: RecurringView }) {
  const [pending, startTransition] = useTransition();
  const paused = item.status === 'paused';

  return (
    <div className={`group ${paused ? 'opacity-55' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm text-ink-dim">{item.merchant}</span>
        <span className="shrink-0 text-sm tnum">
          {item.formattedAmount}
          <span className="text-ink-faint"> {CADENCE_LABEL[item.cadence]}</span>
        </span>
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
        <span className="capitalize">{item.category}</span>
        <span>·</span>
        <span>{item.occurrences} charges</span>

        {item.priceChange && (
          <span className="rounded-full border border-warn/40 bg-warn/10 px-1.5 py-px text-warn">
            {item.priceChange.formatted}
          </span>
        )}

        {/* The valuable one: it used to arrive and then didn't. */}
        {item.overdueDays > 0 && item.status === 'active' && (
          <span className="rounded-full border border-line bg-surface-2 px-1.5 py-px">
            {item.overdueDays} days late
          </span>
        )}

        {paused && <span>paused</span>}
      </div>

      <div className="mt-1 flex gap-2 text-[11px] opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => void markRecurring(item.id, 'cancelled'))}
          className="text-ink-faint hover:text-accent"
        >
          I cancelled this
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => void markRecurring(item.id, paused ? 'active' : 'paused'))}
          className="text-ink-faint hover:text-ink"
        >
          {paused ? 'Unpause' : 'Pause'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => void dismissRecurring(item.id))}
          className="text-ink-faint hover:text-danger"
        >
          Not a subscription
        </button>
      </div>
    </div>
  );
}
