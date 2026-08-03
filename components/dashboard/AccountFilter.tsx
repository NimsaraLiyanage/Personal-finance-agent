'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import type { AccountOption } from '@/lib/finance/account-types';

// Narrow the page to one account.
//
// A filter, not a split. Every serious tracker keeps ONE set of totals for the
// period and treats accounts as a lens over them, because the same Rs 1,200
// dinner is Rs 1,200 of dining whether it left a card or a pocket — which
// pocket does not change what the money was for. Splitting the headline by
// account would mean reading a dining budget in three places.
//
// Where the lens genuinely earns its keep is reconciliation: holding one
// account's rows against the statement the bank sent.
//
// Like the period, it lives in the URL — a view you are looking at should be a
// link you can send or reload back into.

export default function AccountFilter({
  accounts,
  current,
}: {
  accounts: AccountOption[];
  /** Account id, or null for everything. */
  current: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  // Nothing to choose between.
  if (accounts.length < 2) return null;

  const select = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('account', id);
    else next.delete('account');
    startTransition(() => router.push(`${pathname}?${next}`, { scroll: false }));
  };

  const options: Array<{ id: string | null; label: string }> = [
    { id: null, label: 'All accounts' },
    ...accounts.map((account) => ({ id: account.id, label: account.name })),
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Account"
      className={`flex flex-wrap items-center gap-1 text-xs transition-opacity ${
        pending ? 'opacity-60' : ''
      }`}
    >
      {options.map((option) => {
        const active = option.id === current;
        return (
          <button
            key={option.id ?? 'all'}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => select(option.id)}
            className={`rounded-full border px-2.5 py-1 font-medium transition-colors ${
              active
                ? 'border-accent-dim bg-accent-soft text-accent'
                : 'border-line bg-surface text-ink-faint hover:border-line-strong hover:text-ink-dim'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
