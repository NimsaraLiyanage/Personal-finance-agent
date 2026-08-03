// The fact sheet a briefing is written from.
//
// The single most important rule in this file's existence: **the model never
// does arithmetic.** Every figure a briefing quotes is computed here, in code,
// from the ledger, and handed over pre-formatted. The LLM's job is to decide
// what is worth saying and to say it in a sentence — not to work out what 12%
// of last month was. A finance app that lets a language model calculate is one
// hallucinated total away from being untrustworthy, and there is no way for a
// reader to tell the good numbers from the bad ones.

import { prisma } from '../db';
import { formatMoney } from '../money';
import { addDays, monthBounds, startOfDay } from '../agent/time';
import {
  buildSpendingSummary,
  EXCLUDE_TRANSFERS,
  listBudgetStatuses,
  monthProgress,
  type LedgerScope,
} from '../finance/queries';
import { recurringSummary, type RecurringView } from '../finance/recurring';

export interface Mover {
  category: string;
  formattedNow: string;
  formattedBefore: string;
  deltaMinor: number;
  formattedDelta: string;
  direction: 'up' | 'down';
}

export interface BudgetRisk {
  category: string;
  state: 'ok' | 'warning' | 'over';
  usedPct: number;
  monthProgressPct: number;
  formattedSpent: string;
  formattedLimit: string;
  formattedRemaining: string;
  /** True when spending is ahead of a straight-line pace for the month. */
  aheadOfPace: boolean;
}

export interface RecurringCharge {
  merchant: string;
  formatted: string;
  /** How many charges have been matched to it. */
  months: number;
  /** "Netflix went from Rs 1,200 to Rs 1,500", already worded. */
  priceChange: string | null;
  /** Days past the expected date. Above zero means it stopped arriving. */
  overdueDays: number;
}

export interface RecurringFacts {
  charges: RecurringCharge[];
  formattedMonthlyTotal: string;
  activeCount: number;
}

export interface BriefingFacts {
  currency: string;
  periodLabel: string;
  week: {
    formattedSpent: string;
    formattedIncome: string;
    formattedNet: string;
    netMinor: number;
    transactionCount: number;
  };
  previousWeek: {
    formattedSpent: string;
    /** Signed fraction, or null when the previous week had no spending. */
    changePct: number | null;
  };
  movers: Mover[];
  budgets: BudgetRisk[];
  monthToDate: {
    formattedSpent: string;
    progressPct: number;
    daysLeft: number;
    /** Straight-line projection of the full month. Null too early to mean anything. */
    formattedForecast: string | null;
  };
  largestExpense: {
    label: string;
    category: string;
    formatted: string;
    occurredAt: string;
  } | null;
  recurring: RecurringFacts;
  /** Nothing happened this week — the caller should skip the briefing entirely. */
  quiet: boolean;
}

/** The trailing 7 days, and the 7 before it. */
function windows(scope: LedgerScope) {
  const end = addDays(startOfDay(scope.now, scope.timezone), 1, scope.timezone);
  const start = addDays(end, -7, scope.timezone);
  const previousStart = addDays(start, -7, scope.timezone);
  return { start, end, previousStart };
}

export async function gatherBriefingFacts(scope: LedgerScope): Promise<BriefingFacts> {
  const money = (minor: number) => formatMoney(minor, scope.currency);
  const { start, end, previousStart } = windows(scope);

  const [rows, monthSummary, budgetStatuses, recurring] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        userId: scope.userId,
        occurredAt: { gte: previousStart, lt: end },
        ...EXCLUDE_TRANSFERS,
      },
      select: {
        kind: true,
        amountMinor: true,
        category: true,
        merchant: true,
        occurredAt: true,
      },
    }),
    buildSpendingSummary(scope, 'this_month'),
    listBudgetStatuses(scope),
    findRecurringCharges(scope),
  ]);

  // Split the one query into the two windows rather than querying twice.
  const current = rows.filter((r) => r.occurredAt >= start);
  const previous = rows.filter((r) => r.occurredAt < start);

  const sum = (list: typeof rows, kind: 'expense' | 'income') =>
    list.reduce((total, r) => (r.kind === kind ? total + r.amountMinor : total), 0);

  const spent = sum(current, 'expense');
  const income = sum(current, 'income');
  const previousSpent = sum(previous, 'expense');

  const byCategory = (list: typeof rows) => {
    const map = new Map<string, number>();
    for (const r of list) {
      if (r.kind !== 'expense') continue;
      map.set(r.category, (map.get(r.category) ?? 0) + r.amountMinor);
    }
    return map;
  };

  const nowByCategory = byCategory(current);
  const beforeByCategory = byCategory(previous);

  // Biggest week-over-week swings, in either direction. A category that
  // vanished is as interesting as one that doubled.
  const movers: Mover[] = [...new Set([...nowByCategory.keys(), ...beforeByCategory.keys()])]
    .map((category) => {
      const nowMinor = nowByCategory.get(category) ?? 0;
      const beforeMinor = beforeByCategory.get(category) ?? 0;
      const deltaMinor = nowMinor - beforeMinor;
      return {
        category,
        formattedNow: money(nowMinor),
        formattedBefore: money(beforeMinor),
        deltaMinor,
        formattedDelta: money(Math.abs(deltaMinor)),
        direction: (deltaMinor >= 0 ? 'up' : 'down') as 'up' | 'down',
      };
    })
    .filter((m) => m.deltaMinor !== 0)
    .sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor))
    .slice(0, 4);

  const progress = monthProgress(scope.now, scope.timezone);
  const { end: monthEnd } = monthBounds(scope.now, scope.timezone);
  const daysLeft = Math.max(
    0,
    Math.ceil((monthEnd.getTime() - scope.now.getTime()) / 86_400_000),
  );

  const budgets: BudgetRisk[] = budgetStatuses.map((b) => ({
    category: b.category,
    state: b.state,
    usedPct: Math.round(b.usedRatio * 100),
    monthProgressPct: Math.round(b.monthProgress * 100),
    formattedSpent: b.formattedSpent,
    formattedLimit: b.formattedLimit,
    formattedRemaining: b.formattedRemaining,
    // 10 points of slack, so a budget that is merely a little ahead on a
    // Tuesday doesn't get reported as a problem every single week.
    aheadOfPace: b.usedRatio > b.monthProgress + 0.1,
  }));

  const biggest = current
    .filter((r) => r.kind === 'expense')
    .sort((a, b) => b.amountMinor - a.amountMinor)[0];

  return {
    currency: scope.currency,
    periodLabel: formatRange(start, addDays(end, -1, scope.timezone), scope.timezone),
    week: {
      formattedSpent: money(spent),
      formattedIncome: money(income),
      formattedNet: money(income - spent),
      netMinor: income - spent,
      transactionCount: current.length,
    },
    previousWeek: {
      formattedSpent: money(previousSpent),
      changePct: previousSpent > 0 ? (spent - previousSpent) / previousSpent : null,
    },
    movers,
    budgets,
    monthToDate: {
      formattedSpent: monthSummary.formattedSpent,
      progressPct: Math.round(progress * 100),
      daysLeft,
      // Too early in the month and a straight-line projection is noise: one
      // big grocery run on the 2nd would forecast an absurd month.
      formattedForecast:
        progress >= 0.2 ? money(Math.round(monthSummary.totalSpentMinor / progress)) : null,
    },
    largestExpense: biggest
      ? {
          label: biggest.merchant ?? biggest.category,
          category: biggest.category,
          formatted: money(biggest.amountMinor),
          occurredAt: biggest.occurredAt.toISOString(),
        }
      : null,
    recurring,
    quiet: current.length === 0,
  };
}

/**
 * Subscriptions and standing charges, read from the model that tracks them.
 *
 * This used to be re-derived here on every briefing. It cannot be any more, and
 * that is exactly the point of having a model: the facts worth a sentence are
 * "the price went up" and "it stopped arriving", and neither of those exists in
 * a snapshot of the ledger. Only something that remembers last week's answer
 * can notice that this week's is different.
 *
 * Detection runs in the same job, just before this — see the insights route.
 */
async function findRecurringCharges(scope: LedgerScope): Promise<RecurringFacts> {
  const summary = await recurringSummary(scope);

  // The ones worth writing about lead: a price that moved, then one that has
  // stopped arriving, then simply the most expensive.
  const weight = (item: RecurringView) =>
    (item.priceChange ? 2 : 0) + (item.overdueDays > 0 ? 1 : 0);

  const ranked = [...summary.active].sort(
    (a, b) => weight(b) - weight(a) || b.monthlyEquivalentMinor - a.monthlyEquivalentMinor,
  );

  return {
    charges: ranked.slice(0, 4).map((item) => ({
      merchant: item.merchant,
      formatted: `${item.formattedAmount} ${CADENCE_WORD[item.cadence]}`,
      months: item.occurrences,
      priceChange: item.priceChange
        ? `was ${formatMoney(item.priceChange.fromMinor, scope.currency)}, now ${formatMoney(item.priceChange.toMinor, scope.currency)}`
        : null,
      overdueDays: item.overdueDays,
    })),
    formattedMonthlyTotal: summary.formattedMonthlyTotal,
    activeCount: summary.active.length,
  };
}

const CADENCE_WORD: Record<string, string> = {
  weekly: 'a week',
  monthly: 'a month',
  yearly: 'a year',
};

function formatRange(from: Date, to: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone });
  return `${fmt.format(from)} – ${fmt.format(to)}`;
}
