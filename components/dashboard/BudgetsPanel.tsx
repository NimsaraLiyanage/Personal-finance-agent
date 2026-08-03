'use client';

import { useRef, useState, useTransition } from 'react';

import { removeBudget, saveBudget } from '@/app/actions/finance';
import type { BudgetStatus } from '@/lib/agent/types';
import type { CategoryOption } from '@/lib/finance/categories';

// Budgets as meters.
//
// The pace marker is the part that makes these honest: 70% of a budget spent is
// fine on the 25th and alarming on the 5th, and a bar without a "where you
// should be by now" tick can't tell those apart.

export default function BudgetsPanel({
  budgets,
  categories,
  scoped = false,
}: {
  budgets: BudgetStatus[];
  categories: CategoryOption[];
  /** True when the page is filtered to one account — these bars are not. */
  scoped?: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await saveBudget(formData);
      if (!result.ok) setError(result.error ?? 'Could not save that budget.');
      else form.current?.reset();
    });
  };

  const drop = (category: string) => {
    startTransition(async () => {
      await removeBudget(category);
    });
  };

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint">
        Monthly budgets
      </h2>

      {/* A budget is a ceiling on a category, not on a pocket: the same dinner
          counts against dining whether it left a card or a wallet. So these
          bars ignore the account filter, and say so rather than looking like
          they were filtered and came back small. */}
      {scoped && budgets.length > 0 && (
        <p className="mb-3 text-[11px] leading-relaxed text-ink-faint">
          Counting every account — a budget is a limit on a category, not on where you paid from.
        </p>
      )}

      {budgets.length === 0 ? (
        <p className="mb-4 text-sm text-ink-faint">
          No budgets yet. Set a ceiling and every entry gets measured against it.
        </p>
      ) : (
        <ul className="mb-4 space-y-3.5">
          {budgets.map((budget) => (
            <li key={budget.category} className="group">
              <Meter budget={budget} onRemove={() => drop(budget.category)} />
            </li>
          ))}
        </ul>
      )}

      <form
        ref={form}
        action={submit}
        className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
      >
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-[11px] text-ink-faint">Category</span>
          <select name="category" defaultValue={categories[0]?.slug ?? 'other'} className={inputClass}>
            {categories.map((category) => (
              <option key={category.slug} value={category.slug}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label className="w-24">
          <span className="mb-1 block text-[11px] text-ink-faint">Limit</span>
          <input
            name="monthlyLimit"
            type="number"
            step="0.01"
            min="0.01"
            required
            placeholder="200"
            className={inputClass}
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-dim transition-colors hover:border-accent-dim hover:text-ink disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Set'}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

const inputClass =
  'w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-accent-dim';

function Meter({ budget, onRemove }: { budget: BudgetStatus; onRemove: () => void }) {
  const pct = Math.min(100, Math.round(budget.usedRatio * 100));

  // Fill carries severity; the track is a lighter step of the same hue, so the
  // state of the budget reads across the whole bar rather than just the filled
  // part. Every state also carries words, so colour is never the only signal.
  const fill =
    budget.state === 'over' ? 'bg-danger' : budget.state === 'warning' ? 'bg-warn' : 'bg-accent';
  const track =
    budget.state === 'over'
      ? 'bg-danger/15'
      : budget.state === 'warning'
        ? 'bg-warn/15'
        : 'bg-accent-soft';

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
        <span className="capitalize text-ink-dim">{budget.category}</span>
        <span className="flex items-center gap-2">
          <span className="text-xs tnum text-ink-faint">
            {budget.formattedSpent} / {budget.formattedLimit}
          </span>
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove the ${budget.category} budget`}
            className="rounded px-1 text-xs text-ink-faint opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
          >
            ×
          </button>
        </span>
      </div>

      <div className={`relative h-2 overflow-hidden rounded-full ${track}`}>
        <span
          className={`block h-full rounded-full ${fill} transition-[width] duration-500`}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
        <span
          className="absolute inset-y-0 w-px bg-ink/45"
          style={{ left: `${Math.round(budget.monthProgress * 100)}%` }}
          title="Where spending should be by today"
        />
      </div>

      <div className="mt-1 text-xs tnum text-ink-faint">
        {budget.state === 'over'
          ? `Over by ${budget.formattedRemaining.replace('-', '')}`
          : `${budget.formattedRemaining} left`}
      </div>
    </div>
  );
}
