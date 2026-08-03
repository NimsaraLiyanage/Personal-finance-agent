// Monthly statement.
//
// The ledger as a plain table — description, money in, money out, one row per
// transaction, totalled at the bottom. Deliberately the least clever screen in
// the app: no charts, no interpretation, just the month laid out the way people
// have kept accounts on paper for centuries.

import Link from 'next/link';

import AccountFilter from '@/components/dashboard/AccountFilter';
import { CONTAINER } from '@/components/ui/container';
import { listAccounts, resolveAccount } from '@/lib/finance/accounts';
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
      <Shell month={month.label} previousKey={month.previousKey} nextKey={month.nextKey} filter={null}>
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

  // Resolved, never trusted: an id that isn't theirs comes back null and the
  // page shows the whole month rather than a convincing-looking empty one.
  const accountId = await resolveAccount(
    user.userId,
    typeof params.account === 'string' ? params.account : undefined,
  );
  const accounts = await listAccounts(user.userId, user.currency);
  const filter = <AccountFilter accounts={accounts} current={accountId} />;

  const ledger = await listTransactionsInRange(scope, month.from, month.to, {
    accountId: accountId ?? undefined,
  });
  const dayFormat = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    timeZone: user.timezone,
  });

  // Folded in memory from rows already fetched — the statement and its glance
  // panel must agree, and a second query is a second chance to disagree.
  const spendByCategory = new Map<string, number>();
  for (const t of ledger.transactions) {
    if (t.kind !== 'expense') continue;
    spendByCategory.set(t.category, (spendByCategory.get(t.category) ?? 0) + t.amountMinor);
  }
  const topCategories = [...spendByCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  if (ledger.transactions.length === 0) {
    return (
      <Shell month={month.label} previousKey={month.previousKey} nextKey={month.nextKey} filter={filter} accountId={accountId}>
        <Empty>
          No transactions recorded in {month.label}
          {accountId ? ' on this account' : ''}.
        </Empty>
      </Shell>
    );
  }

  return (
    <Shell month={month.label} previousKey={month.previousKey} nextKey={month.nextKey} filter={filter} accountId={accountId}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
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
                        <div className="truncate">
                          {t.transfer && <span className="text-ink-faint">Transfer </span>}
                          {t.merchant ?? capitalise(t.category)}
                        </div>
                        <div className="text-xs capitalize text-ink-faint">
                          {dayFormat.format(new Date(t.occurredAt))}
                          {t.accountName ? ` · ${t.accountName}` : ''}
                          {t.transfer ? '' : ` · ${t.category}`}
                          {t.note ? ` · ${t.note}` : ''}
                        </div>
                      </td>

                      {/* A transfer sits in neither column and is in neither
                          total: your own money changing pocket is not income
                          and not spending. It stays on the page because it did
                          happen and a balance moved. */}
                      {t.transfer ? (
                        <td colSpan={2} className="px-4 py-2.5 text-right text-xs tnum text-ink-faint">
                          {t.formatted} moved
                        </td>
                      ) : (
                        <>
                          <td className="px-4 py-2.5 text-right tnum text-accent">
                            {income ? t.formatted : ''}
                          </td>
                          <td className="px-4 py-2.5 text-right tnum">
                            {income ? '' : t.formatted}
                          </td>
                        </>
                      )}
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

        <aside className="space-y-4">
          <section className="card p-4">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint">
              Month at a glance
            </h2>
            <dl className="space-y-2 text-sm">
              <GlanceRow term="Income" value={formatMoney(ledger.incomeMinor, user.currency)} tone="good" />
              <GlanceRow term="Expenses" value={formatMoney(ledger.expenseMinor, user.currency)} />
              <div className="border-t border-line pt-2">
                <GlanceRow
                  term="Net"
                  value={formatMoney(ledger.netMinor, user.currency)}
                  tone={ledger.netMinor === 0 ? undefined : ledger.netMinor > 0 ? 'good' : 'bad'}
                  strong
                />
              </div>
            </dl>
          </section>

          {topCategories.length > 0 && (
            <section className="card p-4">
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint">
                Biggest categories
              </h2>
              <dl className="space-y-2 text-sm">
                {topCategories.map(([category, minor]) => (
                  <GlanceRow
                    key={category}
                    term={capitalise(category)}
                    value={formatMoney(minor, user.currency)}
                  />
                ))}
              </dl>
            </section>
          )}

          <p className="px-1 text-[11px] leading-relaxed text-ink-faint">
            Charts, budgets and manual entry live on the{' '}
            <Link href="/" className="text-accent hover:underline">
              dashboard
            </Link>
            . This page is just the month, in order.
          </p>
        </aside>
      </div>
    </Shell>
  );
}

function GlanceRow({
  term,
  value,
  tone,
  strong,
}: {
  term: string;
  value: string;
  tone?: 'good' | 'bad';
  strong?: boolean;
}) {
  const colour = tone === 'good' ? 'text-accent' : tone === 'bad' ? 'text-danger' : 'text-ink';
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? 'font-medium text-ink' : 'text-ink-dim'}>{term}</dt>
      <dd className={`tnum ${strong ? 'font-semibold' : ''} ${colour}`}>{value}</dd>
    </div>
  );
}

function Shell({
  month,
  previousKey,
  nextKey,
  filter,
  accountId = null,
  children,
}: {
  month: string;
  previousKey: string;
  nextKey: string | null;
  filter: React.ReactNode;
  accountId?: string | null;
  children: React.ReactNode;
}) {
  // Month arrows must carry the filter, or stepping back a month silently
  // widens the view back to every account.
  const href = (monthKey: string) =>
    `/summary?month=${monthKey}${accountId ? `&account=${accountId}` : ''}`;
  return (
    <main className="scroll-quiet h-full overflow-y-auto">
      <div className={`${CONTAINER} space-y-4 py-5 sm:py-6`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Summary</h1>
            <p className="text-xs text-ink-faint">{month}</p>
          </div>

          {/* Plain links, not buttons: month navigation should survive a
              reload and be shareable, and it needs no JavaScript to work. */}
          <nav aria-label="Month" className="flex items-center gap-1">
            <MonthLink href={href(previousKey)} label="Previous month">
              ←
            </MonthLink>
            {nextKey ? (
              <MonthLink href={href(nextKey)} label="Next month">
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

        {filter}

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
