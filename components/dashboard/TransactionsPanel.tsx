'use client';

import { useState, useTransition } from 'react';

import { removeTransaction } from '@/app/actions/finance';
import type { TransactionView } from '@/lib/agent/types';

// The ledger itself. Rows are deletable because the fastest way to lose trust
// in a tracker is to be stuck with a number you know is wrong.

export default function TransactionsPanel({
  transactions,
  periodLabel,
  timezone,
}: {
  transactions: TransactionView[];
  periodLabel: string;
  timezone: string;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const remove = (id: string) => {
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      const result = await removeTransaction(id);
      if (!result.ok) setError(result.error ?? 'Could not remove that.');
      setPendingId(null);
    });
  };

  const dateFormat = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  });

  return (
    <section className="card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
          Transactions
        </h2>
        <span className="text-[11px] text-ink-faint">{periodLabel}</span>
      </div>

      {error && (
        <p role="alert" className="mb-2 rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      {transactions.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-faint">
          Nothing logged in this period.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {transactions.map((t) => {
            const income = t.kind === 'income';
            const busy = pendingId === t.id;
            return (
              <li
                key={t.id}
                className={`group flex items-center gap-3 py-2.5 transition-opacity ${
                  busy ? 'opacity-40' : ''
                }`}
              >
                <span
                  aria-hidden
                  className={`grid size-8 shrink-0 place-items-center rounded-full text-xs ${
                    income ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-dim'
                  }`}
                >
                  {income ? '↓' : '↑'}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{t.merchant ?? t.category}</div>
                  <div className="text-xs capitalize text-ink-faint">
                    {t.category} · {dateFormat.format(new Date(t.occurredAt))}
                  </div>
                </div>

                <div className={`shrink-0 text-sm font-medium tnum ${income ? 'text-accent' : ''}`}>
                  {income ? '+' : '−'}
                  {t.formatted}
                </div>

                <button
                  type="button"
                  onClick={() => remove(t.id)}
                  disabled={busy}
                  aria-label={`Remove ${t.formatted} ${t.category}`}
                  // Visible on hover for pointer users, always reachable by
                  // keyboard — an action that only exists on hover is an action
                  // half the people using this can't perform.
                  className="shrink-0 rounded-lg px-2 py-1 text-xs text-ink-faint opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
