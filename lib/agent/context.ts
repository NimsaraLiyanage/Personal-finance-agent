// The account snapshot injected into every system prompt.
//
// Without this the agent starts each turn blind and burns a tool call just to
// learn what month it is or whether a budget exists. With it, the common case
// ("am I over on dining?") is answered from the prompt and only genuinely new
// lookups cost a round trip.
//
// It is deliberately SMALL — totals and budget lines, never the transaction
// list. A snapshot that grows with the ledger would eventually dominate the
// context window and cost more than the tool call it saves.

import { prisma } from '../db';
import { listAccountBalances } from '../finance/accounts';
import { listCategories, listCategoryRules } from '../finance/categories';
import { EXCLUDE_TRANSFERS } from '../finance/queries';
import { formatMoney } from '../money';
import { monthBounds, nowInZone, formatDateInZone } from './time';
import type { Category } from './types';

export interface AccountSnapshot {
  currency: string;
  todayIso: string;
  monthLabel: string;
  monthSpentMinor: number;
  monthIncomeMinor: number;
  transactionCount: number;
  topCategories: Array<{ category: Category; totalMinor: number }>;
  budgets: Array<{ category: Category; limitMinor: number; spentMinor: number }>;
  lastTransactionAt: string | null;
  /** The user's own category list — the vocabulary the model should stick to. */
  categories: Array<{ slug: string; label: string }>;
  /** Corrections they have already made. Repeating a fixed mistake is the worst failure here. */
  rules: Array<{ pattern: string; categorySlug: string }>;
  /** Where their money sits. "How much have I got?" is answered from here. */
  accounts: Array<{ name: string; kind: string; balanceMinor: number }>;
}

export async function loadAccountSnapshot(args: {
  userId: string;
  currency: string;
  timezone: string;
  clientNow?: string;
}): Promise<AccountSnapshot> {
  const now = nowInZone(args.clientNow, args.timezone);
  const { start, end } = monthBounds(now, args.timezone);

  const [transactions, budgets, latest, categories, rules, balances] = await Promise.all([
    prisma.transaction.findMany({
      // Transfers excluded: the snapshot's "spent this month" has to agree with
      // the dashboard's, and the dashboard does not count moving money.
      where: {
        userId: args.userId,
        occurredAt: { gte: start, lt: end },
        ...EXCLUDE_TRANSFERS,
      },
      select: { kind: true, amountMinor: true, category: true },
    }),
    prisma.budget.findMany({
      where: { userId: args.userId },
      select: { category: true, limitMinor: true },
    }),
    prisma.transaction.findFirst({
      where: { userId: args.userId },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    }),
    listCategories(args.userId),
    listCategoryRules(args.userId),
    listAccountBalances({
      userId: args.userId,
      currency: args.currency,
      timezone: args.timezone,
      now,
    }),
  ]);

  const spentByCategory = new Map<string, number>();
  let monthSpentMinor = 0;
  let monthIncomeMinor = 0;

  for (const t of transactions) {
    if (t.kind === 'income') {
      monthIncomeMinor += t.amountMinor;
      continue;
    }
    monthSpentMinor += t.amountMinor;
    spentByCategory.set(t.category, (spentByCategory.get(t.category) ?? 0) + t.amountMinor);
  }

  const topCategories = [...spentByCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, totalMinor]) => ({ category: category as Category, totalMinor }));

  return {
    currency: args.currency,
    todayIso: formatDateInZone(now, args.timezone),
    monthLabel: new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: args.timezone,
    }).format(now),
    monthSpentMinor,
    monthIncomeMinor,
    transactionCount: transactions.length,
    topCategories,
    budgets: budgets.map((b) => ({
      category: b.category as Category,
      limitMinor: b.limitMinor,
      spentMinor: spentByCategory.get(b.category) ?? 0,
    })),
    lastTransactionAt: latest ? latest.occurredAt.toISOString() : null,
    accounts: balances.accounts.map((a) => ({
      name: a.name,
      kind: a.kind,
      balanceMinor: a.balanceMinor,
    })),
    categories: categories.map((c) => ({ slug: c.slug, label: c.label })),
    // Capped: the snapshot must not grow with the ledger.
    rules: rules
      .slice(0, 20)
      .map((r) => ({ pattern: r.pattern, categorySlug: r.categorySlug })),
  };
}

/** Render the snapshot as the prompt block the model actually reads. */
export function renderSnapshot(snapshot: AccountSnapshot, timezone: string): string {
  const money = (minor: number) => formatMoney(minor, snapshot.currency);

  const lines: string[] = [
    '## ACCOUNT SNAPSHOT',
    `Today: ${snapshot.todayIso} (${timezone})`,
    `Currency: ${snapshot.currency}`,
    '',
    `### ${snapshot.monthLabel} so far`,
    `Spent: ${money(snapshot.monthSpentMinor)} across ${snapshot.transactionCount} transactions`,
    `Income: ${money(snapshot.monthIncomeMinor)}`,
    `Net: ${money(snapshot.monthIncomeMinor - snapshot.monthSpentMinor)}`,
  ];

  if (snapshot.accounts.length > 0) {
    lines.push(
      '',
      '### Their accounts',
      ...snapshot.accounts.map((a) => `- ${a.name} (${a.kind}): ${money(a.balanceMinor)}`),
      'These balances are current. Answer "how much have I got" from them and do',
      'not add them up unless asked for a total.',
    );
  }

  if (snapshot.categories.length > 0) {
    lines.push(
      '',
      '### Their categories',
      snapshot.categories.map((c) => c.slug).join(', '),
      'Use these names. Only create a new category when nothing here fits.',
    );
  }

  if (snapshot.rules.length > 0) {
    lines.push(
      '',
      '### Corrections they have already made',
      ...snapshot.rules.map((r) => `- anything matching "${r.pattern}" → ${r.categorySlug}`),
      'These are applied automatically when you log. Do not re-litigate them.',
    );
  }

  if (snapshot.topCategories.length > 0) {
    lines.push('', '### Top categories this month');
    for (const c of snapshot.topCategories) {
      lines.push(`- ${c.category}: ${money(c.totalMinor)}`);
    }
  }

  if (snapshot.budgets.length > 0) {
    lines.push('', '### Budgets (this month)');
    for (const b of snapshot.budgets) {
      const pct = b.limitMinor > 0 ? Math.round((b.spentMinor / b.limitMinor) * 100) : 0;
      const flag = pct >= 100 ? ' — OVER' : pct >= 80 ? ' — close to limit' : '';
      lines.push(`- ${b.category}: ${money(b.spentMinor)} of ${money(b.limitMinor)} (${pct}%)${flag}`);
    }
  } else {
    lines.push('', 'No budgets set yet.');
  }

  if (snapshot.transactionCount === 0) {
    lines.push(
      '',
      'This month has no transactions yet. If this is their first message, keep the',
      'welcome to one line and invite them to tell you about a recent purchase.',
    );
  }

  return lines.join('\n');
}
