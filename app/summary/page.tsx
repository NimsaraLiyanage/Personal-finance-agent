// Monthly statement.
//
// The ledger as a plain table — description, money in, money out, one row per
// transaction, totalled at the bottom. Deliberately the least clever screen in
// the app: no charts, no interpretation, just the month laid out the way people
// have kept accounts on paper for centuries.

import Link from 'next/link';

import { formatMoney } from '@/lib/money';
import { listTransactionsInRange, type LedgerScope } from '@/lib/finance/queries';
import { resolveMonth } from '@/lib/finance/months';
import { readUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function SummaryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.month;
  const user = await readUser();

  const timezone = user?.timezone ?? process.env.DEFAULT_TIMEZONE?.trim() ?? 'UTC';
  const month = resolveMonth(typeof raw === 'string' ? raw : undefined, new Date(), timezone);

  if (!user) {
    return (
      <Shell month={month.label} previousKey={month.previousKey} nextKey={month.nextKey}>
        <Empty>
          Nothing here yet. Add an entry on the{' '}
          <Link href="/" className="text-accent hover:underline">
            dashboard
          </Link>{' '}
          and this month fills in.
        </Empty>
      </Shell>
    );
  }

  const scope: LedgerScope = {
    userId: user.userId,
    currency: user.currency,
    timezone: user.timezone,
    now: new Date(),
  };

  const ledger = await listTransactionsInRange(scope, month.from, month.to);
  const dayFormat = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    timeZone: user.timezone,
  });

  return (
    <Shell month={month.label} previousKey={month.previousKey} nextKey={month.nextKey}>
      {ledger.transactions.length === 0 ? (
        <Empty>No transactions recorded in {month.label}.</Empty>
      ) : (
        <div className="card overflow-hidden">
          {/* The table scrolls inside its own box on a narrow screen rather
              than making the whole page scroll sideways. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <caption className="sr-only">
                Transactions for {month.label}, with income and expenses in separate columns.
              </caption>
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Description
                  </th>
                  <th scope="col" className="w-32 px-4 py-2.5 text-right font-medium">
                    Income
                  </th>
                  <th scope="col" className="w-32 px-4 py-2.5 text-right font-medium">
                    Expenses
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-line">
                {ledger.transactions.map((t) => {
                  const income = t.kind === 'income';
                  return (
                    <tr key={t.id} className="transition-colors hover:bg-surface">
                      <td className="px-4 py-2.5">
                        <div className="truncate">{t.merchant ?? capitalise(t.category)}</div>
                        <div className="text-xs capitalize text-ink-faint">
                          {dayFormat.format(new Date(t.occurredAt))} · {t.category}
                          {t.note ? ` · ${t.note}` : ''}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tnum text-accent">
                        {income ? t.formatted : ''}
                      </td>
                      <td className="px-4 py-2.5 text-right tnum">
                        {income ? '' : t.formatted}
                      </td>
                    </tr>
                  );
                })}
              </tbody>

              <tfoot>
                <tr className="border-t-2 border-line-strong bg-surface-2 font-semibold">
                  <th scope="row" className="px-4 py-3 text-left">
                    Totals
                  </th>
                  <td className="px-4 py-3 text-right tnum text-accent">
                    {formatMoney(ledger.incomeMinor, user.currency)}
                  </td>
                  <td className="px-4 py-3 text-right tnum">
                    {formatMoney(ledger.expenseMinor, user.currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line px-4 py-3">
            <span className="text-xs text-ink-faint">
              {ledger.transactions.length}{' '}
              {ledger.transactions.length === 1 ? 'transaction' : 'transactions'} ·{' '}
              {ledger.netMinor >= 0 ? 'kept this month' : 'spent more than came in'}
            </span>
            <span className="flex items-baseline gap-2">
              <span className="text-xs text-ink-faint">Net</span>
              <span
                className={`text-lg font-semibold tabular-nums ${
                  ledger.netMinor === 0
                    ? 'text-ink'
                    : ledger.netMinor > 0
                      ? 'text-accent'
                      : 'text-danger'
                }`}
              >
                {formatMoney(ledger.netMinor, user.currency)}
              </span>
            </span>
          </div>
        </div>
      )}
    </Shell>
  );
}

function Shell({
  month,
  previousKey,
  nextKey,
  children,
}: {
  month: string;
  previousKey: string;
  nextKey: string | null;
  children: React.ReactNode;
}) {
  return (
    <main className="scroll-quiet h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-5 sm:px-6 sm:py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Summary</h1>
            <p className="text-xs text-ink-faint">{month}</p>
          </div>

          {/* Plain links, not buttons: month navigation should survive a
              reload and be shareable, and it needs no JavaScript to work. */}
          <nav aria-label="Month" className="flex items-center gap-1">
            <MonthLink href={`/summary?month=${previousKey}`} label="Previous month">
              ←
            </MonthLink>
            {nextKey ? (
              <MonthLink href={`/summary?month=${nextKey}`} label="Next month">
                →
              </MonthLink>
            ) : (
              <span
                aria-hidden
                className="grid size-8 place-items-center rounded-full border border-line text-sm text-ink-faint/40"
              >
                →
              </span>
            )}
          </nav>
        </div>

        {children}
      </div>
    </main>
  );
}

function MonthLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="grid size-8 place-items-center rounded-full border border-line bg-surface text-sm text-ink-dim transition-colors hover:border-accent-dim hover:text-ink"
    >
      {children}
    </Link>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="card p-10 text-center text-sm text-ink-faint">{children}</div>
  );
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
