// The read model — one implementation of "what does this ledger say".
//
// Both surfaces consume it: the agent's tools (lib/agent/tools.ts) and the
// dashboard's server components. That matters more than it looks. "How much did
// I spend this month" must return the same number whether it is spoken by the
// agent or printed on a tile; two implementations of month-boundary logic drift
// the first time one of them forgets timezones, and then the app argues with
// itself in front of the user.
//
// Nothing here writes. Nothing here knows about React or LangChain. Every
// function takes an explicit `LedgerScope`, so a caller cannot accidentally
// query across users.

import { prisma } from '../db';
import { formatMoney } from '../money';
import type {
  BudgetStatus,
  Category,
  CategoryTotal,
  SpendingSummary,
  TransactionView,
} from '../agent/types';
import {
  addDays,
  monthBounds,
  resolvePeriod,
  startOfDay,
  type PeriodKey,
} from '../agent/time';

export interface LedgerScope {
  userId: string;
  currency: string;
  timezone: string;
  /** The instant "now" resolves to — the client's clock when one was sent. */
  now: Date;
}

export type Granularity = 'day' | 'week' | 'month';

/** One bucket of a time series: gross in, gross out, and the net of the two. */
export interface FlowPoint {
  label: string;
  from: string;
  to: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  formattedIncome: string;
  formattedExpense: string;
  formattedNet: string;
}

// ── Transfers ───────────────────────────────────────────────────────────────

/**
 * The filter that keeps transfers out of income and expense figures.
 *
 * Both halves of a transfer are ordinary rows with a `kind`, so *any* query
 * that adds up money must say this out loud or it will count moving Rs 5,000
 * from the bank to a pocket as both Rs 5,000 earned and Rs 5,000 spent.
 *
 * Balances are the deliberate exception — see lib/finance/accounts.ts.
 */
export const EXCLUDE_TRANSFERS = { transferGroupId: null } as const;

// ── Row shaping ─────────────────────────────────────────────────────────────

interface TransactionRow {
  id: string;
  kind: string;
  amountMinor: number;
  currency: string;
  merchant: string | null;
  category: string;
  note: string | null;
  occurredAt: Date;
  transferGroupId?: string | null;
  accountId?: string | null;
  account?: { name: string } | null;
}

export function toTransactionView(t: TransactionRow): TransactionView {
  return {
    id: t.id,
    kind: t.kind as 'expense' | 'income',
    amountMinor: t.amountMinor,
    currency: t.currency,
    formatted: formatMoney(t.amountMinor, t.currency),
    merchant: t.merchant,
    category: t.category as Category,
    note: t.note,
    occurredAt: t.occurredAt.toISOString(),
    transfer: Boolean(t.transferGroupId),
    // The id as well as the name: the name is what a reader wants, the id is
    // what an edit form has to preselect.
    accountId: t.accountId ?? null,
    accountName: t.account?.name ?? null,
  };
}

/** Rows joined to their account name, which every list wants and no sum does. */
const WITH_ACCOUNT = { account: { select: { name: true } } } as const;

/**
 * One row per transfer instead of two.
 *
 * A transfer is stored as a pair — money leaving one account and arriving in
 * another — but to a reader it is a single event, and a statement that lists
 * "Transfer Rs 5,000" twice looks like a bug even though the totals are right.
 * The outgoing leg survives, because "→ Cash" is how a person describes it.
 *
 * Not applied to account-scoped lists: there, the leg that belongs to the
 * account being viewed is the one that matters, and collapsing would hide the
 * incoming half of every transfer into that account.
 */
function collapseTransferLegs<T extends { transferGroupId: string | null; kind: string }>(
  rows: T[],
): T[] {
  return rows.filter((row) => !row.transferGroupId || row.kind === 'expense');
}

// ── Budgets ─────────────────────────────────────────────────────────────────

/** How far through the current month we are, 0–1. Used to judge budget pace. */
export function monthProgress(now: Date, timezone: string): number {
  const { start, end } = monthBounds(now, timezone);
  const span = end.getTime() - start.getTime();
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / span));
}

export async function buildBudgetStatus(
  scope: LedgerScope,
  category: string,
  limitMinor: number,
): Promise<BudgetStatus> {
  const { start, end } = monthBounds(scope.now, scope.timezone);
  const spend = await prisma.transaction.aggregate({
    where: {
      userId: scope.userId,
      kind: 'expense',
      category,
      occurredAt: { gte: start, lt: end },
      ...EXCLUDE_TRANSFERS,
    },
    _sum: { amountMinor: true },
  });

  const spentMinor = spend._sum.amountMinor ?? 0;
  const remainingMinor = limitMinor - spentMinor;
  const usedRatio = limitMinor > 0 ? spentMinor / limitMinor : 0;

  return {
    category: category as Category,
    limitMinor,
    spentMinor,
    remainingMinor,
    formattedLimit: formatMoney(limitMinor, scope.currency),
    formattedSpent: formatMoney(spentMinor, scope.currency),
    formattedRemaining: formatMoney(remainingMinor, scope.currency),
    usedRatio,
    state: usedRatio >= 1 ? 'over' : usedRatio >= 0.8 ? 'warning' : 'ok',
    monthProgress: monthProgress(scope.now, scope.timezone),
  };
}

export async function listBudgetStatuses(
  scope: LedgerScope,
  category?: string,
): Promise<BudgetStatus[]> {
  const budgets = await prisma.budget.findMany({
    where: { userId: scope.userId, ...(category ? { category } : {}) },
    orderBy: { category: 'asc' },
  });
  return Promise.all(budgets.map((b) => buildBudgetStatus(scope, b.category, b.limitMinor)));
}

// ── Period summary ──────────────────────────────────────────────────────────

export async function buildSpendingSummary(
  scope: LedgerScope,
  period: PeriodKey,
  options: { accountId?: string } = {},
): Promise<SpendingSummary> {
  const window = resolvePeriod(period, scope.now, scope.timezone);
  const money = (minor: number) => formatMoney(minor, scope.currency);
  // Narrows every figure to one pocket. The comparison window narrows with it,
  // or "up 40% on last month" would be one account measured against all of them.
  const account = options.accountId ? { accountId: options.accountId } : {};

  const [rows, previousAgg] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        userId: scope.userId,
        occurredAt: { gte: window.from, lt: window.to },
        ...account,
        ...EXCLUDE_TRANSFERS,
      },
      select: { kind: true, amountMinor: true, category: true },
    }),
    window.previousFrom
      ? prisma.transaction.aggregate({
          where: {
            userId: scope.userId,
            kind: 'expense',
            occurredAt: { gte: window.previousFrom, lt: window.previousTo! },
            ...account,
            ...EXCLUDE_TRANSFERS,
          },
          _sum: { amountMinor: true },
        })
      : Promise.resolve(null),
  ]);

  let totalSpentMinor = 0;
  let totalIncomeMinor = 0;
  const byCategoryMap = new Map<string, { total: number; count: number }>();

  for (const r of rows) {
    if (r.kind === 'income') {
      totalIncomeMinor += r.amountMinor;
      continue;
    }
    totalSpentMinor += r.amountMinor;
    const entry = byCategoryMap.get(r.category) ?? { total: 0, count: 0 };
    entry.total += r.amountMinor;
    entry.count += 1;
    byCategoryMap.set(r.category, entry);
  }

  const byCategory: CategoryTotal[] = [...byCategoryMap.entries()]
    .map(([category, v]) => ({
      category: category as Category,
      totalMinor: v.total,
      formatted: money(v.total),
      share: totalSpentMinor > 0 ? v.total / totalSpentMinor : 0,
      count: v.count,
    }))
    .sort((a, b) => b.totalMinor - a.totalMinor);

  const previousTotalSpentMinor = previousAgg?._sum.amountMinor ?? null;
  const changePct =
    previousTotalSpentMinor && previousTotalSpentMinor > 0
      ? (totalSpentMinor - previousTotalSpentMinor) / previousTotalSpentMinor
      : null;

  return {
    periodLabel: window.label,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    currency: scope.currency,
    totalSpentMinor,
    totalIncomeMinor,
    netMinor: totalIncomeMinor - totalSpentMinor,
    formattedSpent: money(totalSpentMinor),
    formattedIncome: money(totalIncomeMinor),
    formattedNet: money(totalIncomeMinor - totalSpentMinor),
    transactionCount: rows.length,
    byCategory,
    previousTotalSpentMinor,
    changePct,
  };
}

// ── Time series ─────────────────────────────────────────────────────────────

/**
 * Bucket boundaries, oldest first, ending with the bucket containing `now`.
 *
 * Boundaries are computed in the user's zone (a "month" is a calendar month
 * where they live, not a UTC one), which is why this is arithmetic on zoned
 * dates rather than a `date_trunc` in SQL.
 */
function trendBuckets(
  scope: LedgerScope,
  granularity: Granularity,
  buckets: number,
): Array<{ label: string; from: Date; to: Date }> {
  const out: Array<{ label: string; from: Date; to: Date }> = [];
  const dayMonth = (d: Date) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: scope.timezone,
    }).format(d);

  for (let i = buckets - 1; i >= 0; i--) {
    if (granularity === 'day') {
      const from = startOfDay(addDays(scope.now, -i, scope.timezone), scope.timezone);
      out.push({ label: dayMonth(from), from, to: addDays(from, 1, scope.timezone) });
      continue;
    }

    if (granularity === 'week') {
      const anchor = addDays(scope.now, -i * 7, scope.timezone);
      const from = startOfDay(addDays(anchor, -6, scope.timezone), scope.timezone);
      out.push({
        label: dayMonth(from),
        from,
        to: addDays(startOfDay(anchor, scope.timezone), 1, scope.timezone),
      });
      continue;
    }

    // Months: step by calendar month off the current month's start. Anchoring
    // the arithmetic on the 15th keeps a 31st out of a 30-day month.
    const base = monthBounds(scope.now, scope.timezone).start;
    const parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'numeric',
      timeZone: scope.timezone,
    }).formatToParts(base);
    const year = Number(parts.find((p) => p.type === 'year')!.value);
    const month = Number(parts.find((p) => p.type === 'month')!.value);
    const from = monthBounds(new Date(Date.UTC(year, month - 1 - i, 15)), scope.timezone).start;
    const to = monthBounds(new Date(Date.UTC(year, month - i, 15)), scope.timezone).start;
    out.push({
      label: new Intl.DateTimeFormat('en-US', {
        month: 'short',
        timeZone: scope.timezone,
      }).format(from),
      from,
      to,
    });
  }

  return out;
}

/**
 * Income, expense and net per bucket.
 *
 * One query for the whole span, bucketed in memory — the previous shape ran an
 * aggregate per bucket, which is 24 round trips for a two-year chart to compute
 * something that fits in a single scan of an indexed range.
 */
export async function buildFlowSeries(
  scope: LedgerScope,
  options: {
    granularity?: Granularity;
    buckets?: number;
    category?: string;
    accountId?: string;
  } = {},
): Promise<FlowPoint[]> {
  const granularity = options.granularity ?? 'month';
  const buckets = Math.min(Math.max(options.buckets ?? 6, 2), 24);
  const spans = trendBuckets(scope, granularity, buckets);
  if (spans.length === 0) return [];

  const rows = await prisma.transaction.findMany({
    where: {
      userId: scope.userId,
      occurredAt: { gte: spans[0].from, lt: spans[spans.length - 1].to },
      ...(options.category ? { category: options.category } : {}),
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...EXCLUDE_TRANSFERS,
    },
    select: { kind: true, amountMinor: true, occurredAt: true },
  });

  const totals = spans.map(() => ({ income: 0, expense: 0 }));
  for (const row of rows) {
    const at = row.occurredAt.getTime();
    // Buckets are contiguous and ordered, so the first span whose end is past
    // `at` is the one it belongs to.
    const index = spans.findIndex((s) => at >= s.from.getTime() && at < s.to.getTime());
    if (index === -1) continue;
    if (row.kind === 'income') totals[index].income += row.amountMinor;
    else totals[index].expense += row.amountMinor;
  }

  const money = (minor: number) => formatMoney(minor, scope.currency);
  return spans.map((span, i) => {
    const { income, expense } = totals[i];
    return {
      label: span.label,
      from: span.from.toISOString(),
      to: span.to.toISOString(),
      incomeMinor: income,
      expenseMinor: expense,
      netMinor: income - expense,
      formattedIncome: money(income),
      formattedExpense: money(expense),
      formattedNet: money(income - expense),
    };
  });
}

// ── Transactions ────────────────────────────────────────────────────────────

/**
 * Every transaction in an explicit window, oldest first, with the two column
 * totals the statement needs.
 *
 * Ascending order on purpose: this is a statement you read like a page, not a
 * feed you skim from the top.
 */
export async function listTransactionsInRange(
  scope: LedgerScope,
  from: Date,
  to: Date,
  options: { accountId?: string } = {},
): Promise<{
  transactions: TransactionView[];
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}> {
  const rows = await prisma.transaction.findMany({
    where: {
      userId: scope.userId,
      occurredAt: { gte: from, lt: to },
      ...(options.accountId ? { accountId: options.accountId } : {}),
    },
    orderBy: { occurredAt: 'asc' },
    include: WITH_ACCOUNT,
  });

  // Transfers are listed but not totalled. They belong on the statement —
  // something did happen — and in neither money column, because nothing was
  // earned or spent. The table renders them with a dash in both.
  let incomeMinor = 0;
  let expenseMinor = 0;
  for (const row of rows) {
    if (row.transferGroupId) continue;
    if (row.kind === 'income') incomeMinor += row.amountMinor;
    else expenseMinor += row.amountMinor;
  }

  return {
    // Scoped to one account, the leg that touched THAT account is the one worth
    // seeing — collapsing would hide every transfer into it.
    transactions: (options.accountId ? rows : collapseTransferLegs(rows)).map(toTransactionView),
    incomeMinor,
    expenseMinor,
    netMinor: incomeMinor - expenseMinor,
  };
}

/**
 * Free-text match across the three fields a person could plausibly remember:
 * who they paid, what they wrote down, and what it was filed under.
 *
 * Merchant alone is not enough — half the ledger has no merchant at all, and
 * the only trace of "the deposit for the wedding hall" is the note.
 */
function searchFilter(term: string) {
  const contains = { contains: term, mode: 'insensitive' as const };
  return {
    OR: [{ merchant: contains }, { note: contains }, { category: contains }],
  };
}

export async function listTransactions(
  scope: LedgerScope,
  options: {
    period?: PeriodKey;
    category?: string;
    kind?: 'expense' | 'income';
    /** Free text, matched against merchant, note and category. */
    search?: string;
    merchantContains?: string;
    accountId?: string;
    /** Transfers are listed by default; a spending question should pass false. */
    includeTransfers?: boolean;
    limit?: number;
  } = {},
): Promise<{ transactions: TransactionView[]; periodLabel: string }> {
  const window = resolvePeriod(options.period ?? 'this_month', scope.now, scope.timezone);
  const search = options.search?.trim();
  const rows = await prisma.transaction.findMany({
    where: {
      userId: scope.userId,
      occurredAt: { gte: window.from, lt: window.to },
      ...(options.category ? { category: options.category } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(search ? searchFilter(search) : {}),
      ...(options.merchantContains
        ? { merchant: { contains: options.merchantContains, mode: 'insensitive' as const } }
        : {}),
      ...(options.includeTransfers === false ? EXCLUDE_TRANSFERS : {}),
    },
    orderBy: { occurredAt: 'desc' },
    take: Math.min(options.limit ?? 20, 100),
    include: WITH_ACCOUNT,
  });

  return {
    transactions: (options.accountId ? rows : collapseTransferLegs(rows)).map(toTransactionView),
    periodLabel: window.label,
  };
}
