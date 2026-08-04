'use client';

import { useState, useTransition } from 'react';

import { updateTransaction } from '@/app/actions/finance';
import DatePicker from '@/components/ui/DatePicker';
import type { AccountOption } from '@/lib/finance/account-types';
import type { CategoryOption } from '@/lib/finance/categories';
import type { TransactionView } from '@/lib/agent/types';
import { toMajor } from '@/lib/money';

// Correcting an entry, in place.
//
// The same fields as `AddTransaction` and deliberately so — the form that
// created a row is the form that should fix it, or people learn two layouts for
// one idea. It opens inside the ledger row rather than in a modal: the list
// around it is the context that tells you which entry you are editing.

/**
 * The calendar day this instant fell on where the user lives.
 *
 * `en-CA` because it is the one common locale that formats as `YYYY-MM-DD`,
 * which is exactly what the picker and the action both speak.
 */
function dayInZone(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(new Date(iso));
}

export default function TransactionEditor({
  transaction,
  categories,
  accounts,
  today,
  timezone,
  onSaved,
  onCancel,
}: {
  transaction: TransactionView;
  categories: CategoryOption[];
  accounts: AccountOption[];
  /** `YYYY-MM-DD` — the ceiling on the date picker. */
  today: string;
  timezone: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<'expense' | 'income'>(transaction.kind);
  const [date, setDate] = useState(() => dayInZone(transaction.occurredAt, timezone));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A row filed under a category that has since been retired must still show
  // what it says — otherwise the picker silently recategorises it on save.
  const options = categories.some((c) => c.slug === transaction.category)
    ? categories
    : [{ slug: transaction.category, label: transaction.category, builtIn: false }, ...categories];

  const submit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await updateTransaction(formData);
      if (!result.ok) {
        setError(result.error ?? 'Could not save that.');
        return;
      }
      onSaved();
    });
  };

  return (
    <form action={submit} className="space-y-2.5 py-3">
      <input type="hidden" name="id" value={transaction.id} />
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
            className={`flex-1 rounded-full px-3 py-1 font-medium capitalize transition-colors ${
              kind === option
                ? 'bg-surface text-ink shadow-raised'
                : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Amount">
          <input
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            required
            defaultValue={toMajor(transaction.amountMinor, transaction.currency)}
            className={inputClass}
          />
        </Field>
        <Field label="Date">
          <DatePicker name="occurredOn" value={date} onChange={setDate} max={today} />
        </Field>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Category">
          <select name="category" defaultValue={transaction.category} className={inputClass}>
            {options.map((category) => (
              <option key={category.slug} value={category.slug}>
                {category.label}
              </option>
            ))}
          </select>
        </Field>

        {/* Same rule as the add form: only worth a field once there is a choice. */}
        {accounts.length > 1 && (
          <Field label="Account">
            <select
              name="accountId"
              defaultValue={transaction.accountId ?? accounts.find((a) => a.isDefault)?.id ?? ''}
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
      </div>

      <Field label="Merchant" optional>
        <input
          name="merchant"
          type="text"
          maxLength={80}
          defaultValue={transaction.merchant ?? ''}
          placeholder="Keells, rent, payday…"
          className={inputClass}
        />
      </Field>

      <Field label="Note" optional>
        <input
          name="note"
          type="text"
          maxLength={200}
          defaultValue={transaction.note ?? ''}
          className={inputClass}
        />
      </Field>

      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="flex gap-2 pt-0.5">
        <button
          type="submit"
          disabled={pending}
          className="flex-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:bg-line-strong disabled:text-ink-faint"
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border border-line px-3 py-2 text-sm text-ink-dim transition-colors hover:border-line-strong hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
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
