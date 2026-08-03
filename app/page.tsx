// The dashboard.
//
// A Server Component that reads through lib/finance/queries.ts — the same
// module the agent's tools call — so a number here and a number the assistant
// says are the same number by construction, not by coincidence.

import Link from 'next/link';

import AddTransaction from '@/components/dashboard/AddTransaction';
import BudgetsPanel from '@/components/dashboard/BudgetsPanel';
import CategoryBreakdown from '@/components/dashboard/CategoryBreakdown';
import NetFlowChart from '@/components/dashboard/NetFlowChart';
import PeriodTabs from '@/components/dashboard/PeriodTabs';
import StatTile from '@/components/dashboard/StatTile';
import TransactionsPanel from '@/components/dashboard/TransactionsPanel';
import { CONTAINER } from '@/components/ui/container';
import { formatDateInZone } from '@/lib/agent/time';
import {
  buildFlowSeries,
  buildSpendingSummary,
  listBudgetStatuses,
  listTransactions,
  type LedgerScope,
} from '@/lib/finance/queries';
import { parsePeriod, trendShapeFor } from '@/lib/finance/periods';
import { readUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.period;
  const period = parsePeriod(typeof raw === 'string' ? raw : undefined);

  // Never creates a user: a Server Component can't set the cookie that would
  // make one stick, so a first-time visitor gets the onboarding panel and the
  // row is created by their first entry.
  const user = await readUser();
  const fallbackZone = process.env.DEFAULT_TIMEZONE?.trim() || 'UTC';

  if (!user) {
    return (
      <Shell>
        <Onboarding today={formatDateInZone(new Date(), fallbackZone)} />
      </Shell>
    );
  }

  const scope: LedgerScope = {
    userId: user.userId,
    currency: user.currency,
    timezone: user.timezone,
    now: new Date(),
  };
  const trend = trendShapeFor(period);

  const [summary, flow, budgets, ledger] = await Promise.all([
    buildSpendingSummary(scope, period),
    buildFlowSeries(scope, { granularity: trend.granularity, buckets: trend.buckets }),
    listBudgetStatuses(scope),
    listTransactions(scope, { period, limit: 25 }),
  ]);

  const net = summary.netMinor;

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
          <p className="text-xs text-ink-faint">{summary.periodLabel}</p>
        </div>
        <PeriodTabs current={period} />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Income" value={summary.formattedIncome} sub="money in" />
        <StatTile
          label="Spent"
          value={summary.formattedSpent}
          sub={`${summary.transactionCount} ${summary.transactionCount === 1 ? 'entry' : 'entries'}`}
          delta={
            summary.changePct === null
              ? null
              : { pct: summary.changePct, comparedTo: 'previous period', upIsGood: false }
          }
        />
        <StatTile
          label="Net"
          value={summary.formattedNet}
          tone={net === 0 ? 'neutral' : net > 0 ? 'good' : 'bad'}
          sub={net >= 0 ? 'kept this period' : 'more out than in'}
        />
      </div>

      {/* A fixed sidebar track rather than a 2:1 split — fractions would keep
          growing the form with the window, and a 450px-wide amount field is
          worse than a 336px one, not better. The charts take the slack. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="space-y-4">
          <NetFlowChart points={flow} title={trend.title} />
          <CategoryBreakdown
            categories={summary.byCategory}
            totalFormatted={summary.formattedSpent}
            currency={summary.currency}
          />
          <TransactionsPanel
            transactions={ledger.transactions}
            periodLabel={ledger.periodLabel}
            timezone={user.timezone}
          />
        </div>

        <div className="space-y-4">
          <AddTransaction today={formatDateInZone(new Date(), user.timezone)} />
          <BudgetsPanel budgets={budgets} />
          <AssistantNudge />
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="scroll-quiet h-full overflow-y-auto">
      <div className={`${CONTAINER} space-y-4 py-5 sm:py-6`}>{children}</div>
    </main>
  );
}

function AssistantNudge() {
  return (
    <section className="card p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
        Faster than the form
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-dim">
        Type or say “coffee 4.50 and lunch 12.80” and the assistant files both,
        picks the categories, and tells you what it did to your budgets.
      </p>
      <Link
        href="/chat"
        className="mt-3 inline-flex rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-white transition-all hover:brightness-110"
      >
        Open the assistant
      </Link>
    </section>
  );
}

function Onboarding({ today }: { today: string }) {
  return (
    <div className="mx-auto max-w-lg py-8 text-center sm:py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Start your ledger</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-dim">
        Add your first entry below, or just tell the assistant what you spent —
        either way this dashboard fills in from the same ledger.
      </p>

      <div className="mt-6 text-left">
        <AddTransaction today={today} />
      </div>

      <Link
        href="/chat"
        className="mt-4 inline-flex text-sm font-medium text-accent hover:underline"
      >
        Or talk to the assistant instead →
      </Link>
    </div>
  );
}
