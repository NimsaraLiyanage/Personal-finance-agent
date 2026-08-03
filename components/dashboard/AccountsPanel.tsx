'use client';

import { useRef, useState, useTransition } from 'react';

import {
  addAccount,
  closeAccount,
  makeAccountDefault,
  reopenClosedAccount,
  transferBetweenAccounts,
} from '@/app/actions/finance';
import DatePicker from '@/components/ui/DatePicker';
import {
  ACCOUNT_KINDS,
  type AccountBalance,
  type AccountOption,
} from '@/lib/finance/account-types';
import { formatMoney } from '@/lib/money';

// Balances, and moving money between them.
//
// The balance is the number people open a finance app to see, so it leads. The
// transfer form sits under it because a transfer is the only action that
// changes two balances at once — putting it anywhere else makes it look like a
// kind of spending, which is exactly the misunderstanding this feature exists
// to fix.

export default function AccountsPanel({
  accounts,
  closed,
  unassignedMinor,
  unassignedCount,
  currency,
  today,
}: {
  accounts: AccountBalance[];
  closed: AccountOption[];
  unassignedMinor: number;
  unassignedCount: number;
  currency: string;
  today: string;
}) {
  const [mode, setMode] = useState<'none' | 'add' | 'move'>('none');

  return (
    <section className="card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">Accounts</h2>
        <div className="flex items-center gap-2 text-xs">
          {accounts.length > 1 && (
            <button
              type="button"
              onClick={() => setMode(mode === 'move' ? 'none' : 'move')}
              className="text-accent hover:underline"
            >
              {mode === 'move' ? 'Cancel' : 'Move money'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode(mode === 'add' ? 'none' : 'add')}
            className="text-ink-faint transition-colors hover:text-ink"
          >
            {mode === 'add' ? 'Cancel' : '+ Add'}
          </button>
        </div>
      </div>

      <ul className="space-y-2.5">
        {accounts.map((account) => (
          <li key={account.id}>
            <AccountRow account={account} removable={accounts.length > 1} />
          </li>
        ))}
      </ul>

      {unassignedCount > 0 && (
        <p className="mt-3 border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-faint">
          {unassignedCount} {unassignedCount === 1 ? 'entry has' : 'entries have'} no account —
          they were logged before you had any, so they move{' '}
          <span className="tnum">{formatMoney(unassignedMinor, currency)}</span> that no balance
          claims. New entries pick up your default.
        </p>
      )}

      {closed.length > 0 && (
        <details className="mt-3 border-t border-line pt-2.5">
          <summary className="cursor-pointer text-[11px] text-ink-faint">
            {closed.length} closed
          </summary>
          <ul className="mt-2 space-y-1.5">
            {closed.map((account) => (
              <li key={account.id}>
                <ClosedRow account={account} />
              </li>
            ))}
          </ul>
        </details>
      )}

      {mode === 'add' && <AddAccountForm onDone={() => setMode('none')} />}
      {mode === 'move' && (
        <TransferForm accounts={accounts} today={today} onDone={() => setMode('none')} />
      )}
    </section>
  );
}

const KIND_LABEL: Record<string, string> = {
  cash: 'Cash',
  bank: 'Bank',
  card: 'Card',
  wallet: 'Wallet',
};

function AccountRow({ account, removable }: { account: AccountBalance; removable: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="group flex items-baseline justify-between gap-2">
      <span className="min-w-0">
        <span className="truncate text-sm text-ink-dim">{account.name}</span>
        <span className="ml-1.5 text-[11px] text-ink-faint">
          {KIND_LABEL[account.kind] ?? account.kind}
          {account.last4 && ` ••${account.last4}`}
          {account.isDefault && ' · default'}
        </span>
      </span>

      <span className="flex shrink-0 items-baseline gap-1.5">
        <span
          className={`text-sm tnum ${account.balanceMinor < 0 ? 'text-danger' : 'text-ink'}`}
        >
          {account.formattedBalance}
        </span>
        {!account.isDefault && (
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(() => void makeAccountDefault(account.id))}
            title="Make this the default account"
            aria-label={`Make ${account.name} the default account`}
            className="rounded px-1 text-xs text-ink-faint opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 group-hover:opacity-100"
          >
            ★
          </button>
        )}
        {removable && (
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(() => void closeAccount(account.id))}
            title="Close this account — its history is kept"
            aria-label={`Close ${account.name}`}
            className="rounded px-1 text-xs text-ink-faint opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
          >
            ×
          </button>
        )}
      </span>
    </div>
  );
}

function ClosedRow({ account }: { account: AccountOption }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="truncate text-xs text-ink-faint">
        {account.name}
        <span className="ml-1.5">{KIND_LABEL[account.kind] ?? account.kind}</span>
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => void reopenClosedAccount(account.id))}
        className="shrink-0 text-xs text-accent hover:underline disabled:opacity-50"
      >
        {pending ? 'Reopening…' : 'Reopen'}
      </button>
    </div>
  );
}

function AddAccountForm({ onDone }: { onDone: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await addAccount(formData);
      if (!result.ok) setError(result.error ?? 'Could not add that account.');
      else {
        form.current?.reset();
        onDone();
      }
    });
  };

  return (
    <form ref={form} action={submit} className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name">
          <input name="name" required maxLength={40} placeholder="Sampath savings" className={inputClass} />
        </Field>
        <Field label="Type">
          <select name="kind" defaultValue="bank" className={inputClass}>
            {ACCOUNT_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Last 4 digits" optional>
          {/* This is what routes an imported bank SMS to the right account. */}
          <input name="last4" maxLength={4} inputMode="numeric" placeholder="7890" className={inputClass} />
        </Field>
        <Field label="Balance now" optional>
          <input
            name="openingBalance"
            type="number"
            step="0.01"
            placeholder="0.00"
            className={inputClass}
          />
        </Field>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-ink-faint">
        <strong className="font-medium text-ink-dim">Balance now</strong> is what is really in
        there this minute — for Cash, the notes in your pocket. Every entry after this is counted
        from it, so a rough figure is better than leaving it at zero.
      </p>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-dim transition-colors hover:border-accent-dim hover:text-ink disabled:opacity-50"
      >
        {pending ? 'Adding…' : 'Add account'}
      </button>
    </form>
  );
}

function TransferForm({
  accounts,
  today,
  onDone,
}: {
  accounts: AccountBalance[];
  today: string;
  onDone: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await transferBetweenAccounts(formData);
      if (!result.ok) setError(result.error ?? 'Could not move that.');
      else {
        form.current?.reset();
        onDone();
      }
    });
  };

  return (
    <form ref={form} action={submit} className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="From">
          <select name="fromAccountId" defaultValue={accounts[0]?.id} className={inputClass}>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="To">
          <select name="toAccountId" defaultValue={accounts[1]?.id} className={inputClass}>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
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
          <DatePicker name="occurredOn" value={date} onChange={setDate} max={today} />
        </Field>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-ink-faint">
        Both balances move. Nothing is counted as income or spending — it is still your money.
      </p>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-dim transition-colors hover:border-accent-dim hover:text-ink disabled:opacity-50"
      >
        {pending ? 'Moving…' : 'Move money'}
      </button>
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
