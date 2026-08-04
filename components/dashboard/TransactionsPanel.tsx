'use client';

import { useState, useTransition } from 'react';

import { removeTransaction } from '@/app/actions/finance';
import TransactionEditor from '@/components/dashboard/TransactionEditor';
import TransactionSearch from '@/components/dashboard/TransactionSearch';
import type { AccountOption } from '@/lib/finance/account-types';
import type { CategoryOption } from '@/lib/finance/categories';
import type { TransactionView } from '@/lib/agent/types';

// The ledger itself. Rows are editable and deletable because the fastest way to
// lose trust in a tracker is to be stuck with a number you know is wrong.

export default function TransactionsPanel({
  transactions,
  periodLabel,
  timezone,
  categories,
  accounts,
  today,
  filtered = false,
}: {
  transactions: TransactionView[];
  periodLabel: string;
  timezone: string;
  categories: CategoryOption[];
  accounts: AccountOption[];
  /** `YYYY-MM-DD` in the user's zone — nothing can be dated later than this. */
  today: string;
  /** A search or filter is narrowing the list, so the empty state differs. */
  filtered?: boolean;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
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

      <div className="mb-3">
        <TransactionSearch categories={categories} />
      </div>

      {error && (
        <p role="alert" className="mb-2 rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      {transactions.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-faint">
          {filtered ? 'Nothing matches that search.' : 'Nothing logged in this period.'}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {transactions.map((t) => {
            const income = t.kind === 'income';
            const busy = pendingId === t.id;

            if (editingId === t.id) {
              return (
                <li key={t.id}>
                  <TransactionEditor
                    transaction={t}
                    categories={categories}
                    accounts={accounts}
                    today={today}
                    timezone={timezone}
                    onSaved={() => setEditingId(null)}
                    onCancel={() => setEditingId(null)}
                  />
                </li>
              );
            }

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
                  <div className="truncate text-sm capitalize">{t.merchant ?? t.category}</div>
                  <div className="text-xs capitalize text-ink-faint">
                    {t.category} · {dateFormat.format(new Date(t.occurredAt))}
                  </div>
                </div>

                <div className={`shrink-0 text-sm font-medium tnum ${income ? 'text-accent' : ''}`}>
                  {income ? '+' : '−'}
                  {t.formatted}
                </div>

                {/* Visible on hover for pointer users, always reachable by
                    keyboard — an action that only exists on hover is an action
                    half the people using this can't perform. */}
                <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  {/* A transfer's two halves have to agree, so it is corrected
                      by removing and re-recording it, not by editing one leg. */}
                  {!t.transfer && (
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setEditingId(t.id);
                      }}
                      disabled={busy}
                      aria-label={`Edit ${t.formatted} ${t.category}`}
                      className="rounded-lg px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-surface hover:text-ink focus-visible:opacity-100"
                    >
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(t.id)}
                    disabled={busy}
                    aria-label={`Remove ${t.formatted} ${t.category}`}
                    className="rounded-lg px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger focus-visible:opacity-100"
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
