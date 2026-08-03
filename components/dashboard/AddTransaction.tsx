'use client';

import { useRef, useState, useTransition } from 'react';

import { addTransaction } from '@/app/actions/finance';
import DatePicker from '@/components/ui/DatePicker';
import type { AccountOption } from '@/lib/finance/account-types';
import type { CategoryOption } from '@/lib/finance/categories';

// Manual entry, for when typing a sentence to the assistant is more ceremony
// than the task deserves — three fields and done.

export default function AddTransaction({
  today,
  categories,
  accounts = [],
}: {
  today: string;
  categories: CategoryOption[];
  /** Empty before the user row exists — the action falls back to their default. */
  accounts?: AccountOption[];
}) {
  const form = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [date, setDate] = useState(today);
  // Their own word for something is a first-class category, not an "other".
  const [customCategory, setCustomCategory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await addTransaction(formData);
      if (!result.ok) {
        setError(result.error ?? 'Could not save that.');
        return;
      }
      // Keep the kind and date — people log several things in a row, and
      // resetting those every time is the kind of small friction that stops
      // someone using a tracker after a week.
      form.current?.reset();
      setSaved(true);
    });
  };

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint">
        Add an entry
      </h2>

      <form ref={form} action={submit} className="space-y-3">
        <input type="hidden" name="kind" value={kind} />

        <div
          role="radiogroup"
          aria-label="Entry type"
          className="flex rounded-full border border-line bg-surface-2 p-0.5 text-xs"
        >
          {(['expense', 'income'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={kind === option}
              onClick={() => setKind(option)}
              className={`flex-1 rounded-full px-3 py-1.5 font-medium capitalize transition-colors ${
                kind === option
                  ? 'bg-surface text-ink shadow-raised'
                  : 'text-ink-faint hover:text-ink-dim'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Amount">
            <input
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              required
              placeholder="0.00"
              className={inputClass}
            />
          </Field>
          <Field label="Date">
            {/* Keeps whatever day was last picked across submits — people log
                several things from the same day in one sitting. */}
            <DatePicker name="occurredOn" value={date} onChange={setDate} max={today} />
          </Field>
        </div>

        <Field label="Category">
          {customCategory ? (
            <div className="flex gap-1.5">
              <input
                name="category"
                type="text"
                required
                autoFocus
                maxLength={40}
                placeholder="kade, bus, wedding fund…"
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => setCustomCategory(false)}
                className="shrink-0 rounded-lg border border-line px-2 text-xs text-ink-faint transition-colors hover:text-ink"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <select
                name="category"
                defaultValue={categories[0]?.slug ?? 'other'}
                className={inputClass}
              >
                {categories.map((category) => (
                  <option key={category.slug} value={category.slug}>
                    {category.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setCustomCategory(true)}
                aria-label="Create a new category"
                className="shrink-0 rounded-lg border border-line px-2.5 text-sm text-ink-faint transition-colors hover:border-accent-dim hover:text-ink"
              >
                +
              </button>
            </div>
          )}
        </Field>

        {/* Only worth a field once there is a choice to make. With one account
            the action assigns it anyway, so a locked dropdown would be noise. */}
        {accounts.length > 1 && (
          <Field label="Account">
            <select
              name="accountId"
              defaultValue={accounts.find((a) => a.isDefault)?.id ?? accounts[0]?.id}
              className={inputClass}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Merchant or note" optional>
          <input name="merchant" type="text" placeholder="Keells, rent, payday…" className={inputClass} />
        </Field>

        {error && (
          <p role="alert" className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
            {error}
          </p>
        )}
        {saved && !error && (
          <p role="status" className="text-xs text-accent">
            Saved.
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110 disabled:bg-line-strong disabled:text-ink-faint"
        >
          {pending ? 'Saving…' : `Add ${kind}`}
        </button>
      </form>
    </section>
  );
}

const inputClass =
  'w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-accent-dim';

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-ink-faint">
        {label}
        {optional && <span className="text-ink-faint/70"> (optional)</span>}
      </span>
      {children}
    </label>
  );
}
