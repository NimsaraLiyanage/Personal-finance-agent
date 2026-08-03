// The tool surface — the only way the model can read or change anything.
//
// Design rules this file follows:
//
//   - **Zod schemas are the contract.** Descriptions are written for the model,
//     not for a developer: they say when to call the tool and what a good
//     argument looks like, because that text is the entire spec the model sees.
//   - **Tools return a compact summary for the model AND push a rich
//     PendingClientAction for the UI.** The model gets "logged $4.50 dining" in
//     ~15 tokens; the client gets the full typed object to render a card. This
//     split is what keeps token cost flat as cards get richer.
//   - **Every query is scoped by `runtime.userId`.** No tool takes a user id as
//     an argument — a model that can name the user whose data it reads is one
//     prompt injection away from reading everyone's.
//   - **Tools never throw at the model.** A failure returns a plain sentence the
//     model can relay; an exception would abort the whole graph run.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { prisma } from '../db';
import { formatMoney, toMinor } from '../money';
import { CATEGORIES } from './types';
import type {
  BudgetStatus,
  Category,
  CategoryTotal,
  PendingClientAction,
  SpendingSummary,
  ToolRuntime,
  TransactionView,
  TrendPoint,
} from './types';
import {
  addDays,
  formatDateInZone,
  monthBounds,
  nowInZone,
  parseOccurredAt,
  resolvePeriod,
  startOfDay,
  type PeriodKey,
} from './time';

// ── Shared schema fragments ─────────────────────────────────────────────────

const CategoryEnum = z.enum(CATEGORIES);

const PeriodEnum = z
  .enum([
    'today',
    'yesterday',
    'this_week',
    'last_week',
    'this_month',
    'last_month',
    'last_30_days',
    'last_90_days',
    'this_year',
    'all_time',
  ])
  .describe('Which window to report on. Default to this_month if unstated.');

// ── Helpers ─────────────────────────────────────────────────────────────────

function toView(
  t: {
    id: string;
    kind: 'expense' | 'income';
    amountMinor: number;
    currency: string;
    merchant: string | null;
    category: string;
    note: string | null;
    occurredAt: Date;
  },
): TransactionView {
  return {
    id: t.id,
    kind: t.kind,
    amountMinor: t.amountMinor,
    currency: t.currency,
    formatted: formatMoney(t.amountMinor, t.currency),
    merchant: t.merchant,
    category: t.category as Category,
    note: t.note,
    occurredAt: t.occurredAt.toISOString(),
  };
}

function push(runtime: ToolRuntime, action: PendingClientAction): void {
  runtime.actions.push(action);
}

/** How far through the current month we are, 0–1. Used to judge budget pace. */
function monthProgress(now: Date, timezone: string): number {
  const { start, end } = monthBounds(now, timezone);
  const span = end.getTime() - start.getTime();
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / span));
}

async function buildBudgetStatus(
  runtime: ToolRuntime,
  category: string,
  limitMinor: number,
  now: Date,
): Promise<BudgetStatus> {
  const { start, end } = monthBounds(now, runtime.timezone);
  const spend = await prisma.transaction.aggregate({
    where: {
      userId: runtime.userId,
      kind: 'expense',
      category,
      occurredAt: { gte: start, lt: end },
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
    formattedLimit: formatMoney(limitMinor, runtime.currency),
    formattedSpent: formatMoney(spentMinor, runtime.currency),
    formattedRemaining: formatMoney(remainingMinor, runtime.currency),
    usedRatio,
    state: usedRatio >= 1 ? 'over' : usedRatio >= 0.8 ? 'warning' : 'ok',
    monthProgress: monthProgress(now, runtime.timezone),
  };
}

// ── Tool factory ────────────────────────────────────────────────────────────

export function buildTools(runtime: ToolRuntime) {
  const now = () => nowInZone(runtime.clientNow, runtime.timezone);
  const money = (minor: number) => formatMoney(minor, runtime.currency);

  // ---- log_transaction ----------------------------------------------------

  const logTransaction = tool(
    async (input) => {
      try {
        const at = parseOccurredAt(input.occurred_on, now(), runtime.timezone);
        const amountMinor = toMinor(input.amount, runtime.currency);
        if (amountMinor <= 0) {
          return 'Amount must be greater than zero. Ask the user to restate it.';
        }

        const created = await prisma.transaction.create({
          data: {
            userId: runtime.userId,
            kind: input.kind,
            amountMinor,
            currency: runtime.currency,
            merchant: input.merchant?.trim() || null,
            category: input.category,
            note: input.note?.trim() || null,
            occurredAt: at,
            source: input.source ?? 'chat',
          },
        });

        const view = toView({ ...created, kind: created.kind as 'expense' | 'income' });

        // If this spend touches a budgeted category, attach the updated status
        // so the card can show the bar moving — and so the model can mention an
        // overrun without a second tool call.
        let budgetTouched: BudgetStatus | undefined;
        if (input.kind === 'expense') {
          const budget = await prisma.budget.findUnique({
            where: { userId_category: { userId: runtime.userId, category: input.category } },
            select: { limitMinor: true },
          });
          if (budget) {
            budgetTouched = await buildBudgetStatus(
              runtime,
              input.category,
              budget.limitMinor,
              now(),
            );
          }
        }

        push(runtime, { type: 'transaction_logged', transaction: view, budgetTouched });

        const label = [view.merchant, view.category].filter(Boolean).join(', ');
        const base = `Logged ${input.kind}: ${view.formatted} (${label}) on ${formatDateInZone(at, runtime.timezone)}.`;
        if (budgetTouched?.state === 'over') {
          return `${base} This puts ${input.category} at ${budgetTouched.formattedSpent} against a ${budgetTouched.formattedLimit} budget — over by ${money(Math.abs(budgetTouched.remainingMinor))}.`;
        }
        if (budgetTouched?.state === 'warning') {
          return `${base} ${input.category} is now at ${Math.round(budgetTouched.usedRatio * 100)}% of its ${budgetTouched.formattedLimit} budget.`;
        }
        return base;
      } catch (err) {
        return `Could not save that transaction: ${(err as Error).message}`;
      }
    },
    {
      name: 'log_transaction',
      description: [
        'Record one expense or income. Call this the moment the user mentions money',
        'moving — do not ask for confirmation first.',
        'If the user mentions several items in one message ("coffee 4.50 and lunch 12"),',
        'call this tool once per item in the SAME turn rather than asking which came first.',
        'Infer the category yourself; only ask if it is genuinely ambiguous.',
      ].join(' '),
      schema: z.object({
        kind: z
          .enum(['expense', 'income'])
          .describe('expense for money out, income for money in (salary, refund, gift).'),
        amount: z
          .number()
          .positive()
          .describe('Positive decimal in the user\'s currency, exactly as stated. 4.50 not 450.'),
        category: CategoryEnum.describe('Best-fit category. Use "other" only as a last resort.'),
        merchant: z
          .string()
          .optional()
          .describe('Where it happened, if named: "Starbucks", "Keells", "landlord".'),
        note: z.string().optional().describe('Any extra detail worth keeping. Keep it short.'),
        occurred_on: z
          .string()
          .optional()
          .describe(
            'ISO date (YYYY-MM-DD) when the money actually moved. Resolve relative dates like "yesterday" against today\'s date in the snapshot. Omit if it just happened.',
          ),
        source: z.enum(['chat', 'voice', 'manual']).optional(),
      }),
    },
  );

  // ---- get_spending_summary ----------------------------------------------

  const getSpendingSummary = tool(
    async (input) => {
      const period = resolvePeriod(input.period as PeriodKey, now(), runtime.timezone);

      const [rows, previousAgg] = await Promise.all([
        prisma.transaction.findMany({
          where: {
            userId: runtime.userId,
            occurredAt: { gte: period.from, lt: period.to },
          },
          select: { kind: true, amountMinor: true, category: true },
        }),
        period.previousFrom
          ? prisma.transaction.aggregate({
              where: {
                userId: runtime.userId,
                kind: 'expense',
                occurredAt: { gte: period.previousFrom, lt: period.previousTo! },
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

      const summary: SpendingSummary = {
        periodLabel: period.label,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        currency: runtime.currency,
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

      push(runtime, { type: 'spending_summary', summary });

      if (rows.length === 0) {
        return `No transactions recorded for ${period.label.toLowerCase()}.`;
      }
      const top = byCategory
        .slice(0, 3)
        .map((c) => `${c.category} ${c.formatted}`)
        .join(', ');
      const delta =
        changePct === null
          ? ''
          : ` That is ${Math.abs(Math.round(changePct * 100))}% ${changePct >= 0 ? 'more than' : 'less than'} the previous period.`;
      return `${period.label}: spent ${summary.formattedSpent} across ${rows.length} transactions. Top: ${top}.${delta}`;
    },
    {
      name: 'get_spending_summary',
      description:
        'Totals and a category breakdown for a period. Use for "how much did I spend", "where did my money go", "how was last month". Renders a summary card, so keep your spoken reply to the headline only.',
      schema: z.object({ period: PeriodEnum }),
    },
  );

  // ---- list_transactions --------------------------------------------------

  const listTransactions = tool(
    async (input) => {
      const period = resolvePeriod((input.period ?? 'this_month') as PeriodKey, now(), runtime.timezone);
      const limit = Math.min(input.limit ?? 20, 50);

      const rows = await prisma.transaction.findMany({
        where: {
          userId: runtime.userId,
          occurredAt: { gte: period.from, lt: period.to },
          ...(input.category ? { category: input.category } : {}),
          ...(input.merchant_contains
            ? { merchant: { contains: input.merchant_contains, mode: 'insensitive' as const } }
            : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: limit,
      });

      const transactions = rows.map((r) => toView({ ...r, kind: r.kind as 'expense' | 'income' }));
      const heading = [
        input.category ? `${input.category} transactions` : 'Transactions',
        period.label.toLowerCase(),
      ].join(' — ');

      push(runtime, { type: 'transaction_list', transactions, heading });

      if (transactions.length === 0) return `No matching transactions for ${period.label.toLowerCase()}.`;
      const total = transactions.reduce((a, t) => a + (t.kind === 'expense' ? t.amountMinor : 0), 0);
      return `Found ${transactions.length} transactions totalling ${money(total)}. The list is on screen.`;
    },
    {
      name: 'list_transactions',
      description:
        'Fetch individual transactions, optionally filtered by category or merchant. Use for "what did I buy at X", "show me my dining spend", "list last week". Returns a list card — do not read every row aloud.',
      schema: z.object({
        period: PeriodEnum.optional(),
        category: CategoryEnum.optional(),
        merchant_contains: z
          .string()
          .optional()
          .describe('Case-insensitive substring of the merchant name.'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
  );

  // ---- set_budget ---------------------------------------------------------

  const setBudget = tool(
    async (input) => {
      const limitMinor = toMinor(input.monthly_limit, runtime.currency);
      if (limitMinor <= 0) return 'A budget must be greater than zero.';

      const saved = await prisma.budget.upsert({
        where: { userId_category: { userId: runtime.userId, category: input.category } },
        create: {
          userId: runtime.userId,
          category: input.category,
          limitMinor,
          currency: runtime.currency,
        },
        update: { limitMinor, currency: runtime.currency },
      });

      const status = await buildBudgetStatus(runtime, saved.category, saved.limitMinor, now());
      push(runtime, { type: 'budget_saved', budget: status });

      return `Budget set: ${money(limitMinor)} per month for ${input.category}. Already spent ${status.formattedSpent} this month.`;
    },
    {
      name: 'set_budget',
      description:
        'Create or update a monthly spending ceiling for one category. Use when the user says "keep dining under 200" or "set a grocery budget".',
      schema: z.object({
        category: CategoryEnum,
        monthly_limit: z
          .number()
          .positive()
          .describe('Monthly ceiling as a decimal in the user\'s currency.'),
      }),
    },
  );

  // ---- get_budget_status --------------------------------------------------

  const getBudgetStatus = tool(
    async (input) => {
      const budgets = await prisma.budget.findMany({
        where: {
          userId: runtime.userId,
          ...(input.category ? { category: input.category } : {}),
        },
        orderBy: { category: 'asc' },
      });

      if (budgets.length === 0) {
        push(runtime, { type: 'budget_status', budgets: [] });
        return input.category
          ? `No budget set for ${input.category}. Offer to create one.`
          : 'No budgets set yet. Offer to create one.';
      }

      const at = now();
      const statuses = await Promise.all(
        budgets.map((b) => buildBudgetStatus(runtime, b.category, b.limitMinor, at)),
      );
      push(runtime, { type: 'budget_status', budgets: statuses });

      const over = statuses.filter((s) => s.state === 'over');
      const warning = statuses.filter((s) => s.state === 'warning');
      if (over.length > 0) {
        return `Over budget: ${over.map((s) => `${s.category} (${s.formattedSpent} of ${s.formattedLimit})`).join(', ')}. ${warning.length} more are close.`;
      }
      if (warning.length > 0) {
        return `Nothing over yet. Close to the limit: ${warning.map((s) => `${s.category} at ${Math.round(s.usedRatio * 100)}%`).join(', ')}.`;
      }
      return `All ${statuses.length} budgets are on track this month.`;
    },
    {
      name: 'get_budget_status',
      description:
        'Current month spend against each budget. Use for "am I over on dining", "how are my budgets", or before advising on a discretionary purchase.',
      schema: z.object({
        category: CategoryEnum.optional().describe('Omit to get every budget.'),
      }),
    },
  );

  // ---- get_spending_trend -------------------------------------------------

  const getSpendingTrend = tool(
    async (input) => {
      const buckets = Math.min(input.buckets ?? 6, 24);
      const granularity = input.granularity ?? 'month';
      const at = now();

      const points: TrendPoint[] = [];
      let earliest = at;

      // Walk backwards one bucket at a time. Each bucket is a separate
      // aggregate rather than one grouped query because bucket boundaries are
      // timezone-local and Postgres would need the user's zone pushed into the
      // GROUP BY to match — which it can do, but not portably through Prisma's
      // typed API. At <=24 buckets the extra round trips are cheap.
      for (let i = buckets - 1; i >= 0; i--) {
        let from: Date;
        let to: Date;
        let label: string;

        if (granularity === 'day') {
          from = startOfDay(addDays(at, -i, runtime.timezone), runtime.timezone);
          to = addDays(from, 1, runtime.timezone);
          label = new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: runtime.timezone,
          }).format(from);
        } else if (granularity === 'week') {
          const anchor = addDays(at, -i * 7, runtime.timezone);
          from = startOfDay(addDays(anchor, -6, runtime.timezone), runtime.timezone);
          to = addDays(startOfDay(anchor, runtime.timezone), 1, runtime.timezone);
          label = new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: runtime.timezone,
          }).format(from);
        } else {
          const base = monthBounds(at, runtime.timezone).start;
          const parts = new Intl.DateTimeFormat('en-US', {
            year: 'numeric',
            month: 'numeric',
            timeZone: runtime.timezone,
          }).formatToParts(base);
          const year = Number(parts.find((p) => p.type === 'year')!.value);
          const month = Number(parts.find((p) => p.type === 'month')!.value);
          from = monthBounds(new Date(Date.UTC(year, month - 1 - i, 15)), runtime.timezone).start;
          to = monthBounds(new Date(Date.UTC(year, month - i, 15)), runtime.timezone).start;
          label = new Intl.DateTimeFormat('en-US', {
            month: 'short',
            timeZone: runtime.timezone,
          }).format(from);
        }

        if (from < earliest) earliest = from;

        const agg = await prisma.transaction.aggregate({
          where: {
            userId: runtime.userId,
            kind: 'expense',
            occurredAt: { gte: from, lt: to },
            ...(input.category ? { category: input.category } : {}),
          },
          _sum: { amountMinor: true },
        });
        const totalMinor = agg._sum.amountMinor ?? 0;
        points.push({ label, totalMinor, formatted: money(totalMinor) });
      }

      const title = input.category
        ? `${input.category} spend by ${granularity}`
        : `Spend by ${granularity}`;
      push(runtime, { type: 'trend_chart', title, points, currency: runtime.currency });

      const nonZero = points.filter((p) => p.totalMinor > 0);
      if (nonZero.length === 0) return 'No spending recorded in that range.';
      const latest = points[points.length - 1];
      const average = Math.round(points.reduce((a, p) => a + p.totalMinor, 0) / points.length);
      return `Chart is on screen. Latest ${granularity}: ${latest.formatted}, against a ${money(average)} average over ${points.length} ${granularity}s.`;
    },
    {
      name: 'get_spending_trend',
      description:
        'Spending over time as a series, for "is my spending going up", "compare the last few months", or any trend question. Renders a chart card.',
      schema: z.object({
        granularity: z.enum(['day', 'week', 'month']).optional().describe('Defaults to month.'),
        buckets: z
          .number()
          .int()
          .min(2)
          .max(24)
          .optional()
          .describe('How many periods back, including the current one. Defaults to 6.'),
        category: CategoryEnum.optional().describe('Omit for total spend.'),
      }),
    },
  );

  // ---- delete_transaction -------------------------------------------------

  const deleteTransaction = tool(
    async (input) => {
      const target = input.transaction_id
        ? await prisma.transaction.findFirst({
            where: { id: input.transaction_id, userId: runtime.userId },
          })
        : await prisma.transaction.findFirst({
            where: { userId: runtime.userId },
            orderBy: { createdAt: 'desc' },
          });

      if (!target) return 'There is no matching transaction to remove.';

      await prisma.transaction.delete({ where: { id: target.id } });
      const view = toView({ ...target, kind: target.kind as 'expense' | 'income' });
      push(runtime, { type: 'navigate', screen: 'transactions' });
      return `Removed ${view.formatted} (${view.category}${view.merchant ? `, ${view.merchant}` : ''}).`;
    },
    {
      name: 'delete_transaction',
      description:
        'Remove a transaction. With no id, removes the most recently created one — use that for "undo", "scratch that", "I logged that twice".',
      schema: z.object({
        transaction_id: z
          .string()
          .optional()
          .describe('Omit to delete the most recently created transaction.'),
      }),
    },
  );

  // ---- schedule_reminder --------------------------------------------------

  const scheduleReminder = tool(
    async (input) => {
      const at = now();
      const dueAt =
        input.in_minutes !== undefined
          ? new Date(at.getTime() + input.in_minutes * 60_000)
          : parseOccurredAt(input.due_at, at, runtime.timezone);

      if (dueAt.getTime() <= at.getTime()) {
        return 'That time is already in the past — ask the user when they want it instead.';
      }

      const dedupeKey = input.dedupe_key?.trim() || null;
      await prisma.reminder.upsert({
        where: dedupeKey
          ? { userId_dedupeKey: { userId: runtime.userId, dedupeKey } }
          : { id: '__never__' },
        create: {
          userId: runtime.userId,
          title: input.title,
          body: input.body,
          dueAt,
          category: input.category ?? 'general',
          dedupeKey,
        },
        update: { title: input.title, body: input.body, dueAt },
      });

      push(runtime, {
        type: 'reminder_scheduled',
        title: input.title,
        body: input.body,
        when:
          input.in_minutes !== undefined
            ? { kind: 'relative', offsetMinutes: input.in_minutes }
            : { kind: 'absolute', isoDatetime: dueAt.toISOString() },
        category: input.category ?? 'general',
        ...(dedupeKey ? { dedupeKey } : {}),
      });

      return `Reminder set for ${dueAt.toISOString()}: ${input.title}.`;
    },
    {
      name: 'schedule_reminder',
      description:
        'Schedule a nudge — a bill due, a savings check-in, a "review your dining spend on Sunday". Give either in_minutes or due_at, not both.',
      schema: z.object({
        title: z.string().describe('Short, under 50 characters.'),
        body: z.string().describe('One sentence of detail.'),
        in_minutes: z.number().int().positive().optional().describe('Minutes from now.'),
        due_at: z
          .string()
          .optional()
          .describe('ISO date or datetime, interpreted in the user\'s timezone.'),
        category: z.string().optional(),
        dedupe_key: z
          .string()
          .optional()
          .describe('Stable key so re-asking does not stack duplicates, e.g. "rent-2026-09".'),
      }),
    },
  );

  // ---- navigate_to --------------------------------------------------------

  const navigateTo = tool(
    async (input) => {
      push(runtime, { type: 'navigate', screen: input.screen });
      return `Opened ${input.screen}.`;
    },
    {
      name: 'navigate_to',
      description:
        'Move the app to another screen when the user asks to see something rather than be told it ("show me my budgets", "open the dashboard").',
      schema: z.object({
        screen: z.enum(['dashboard', 'transactions', 'budgets', 'insights']),
      }),
    },
  );

  // ---- end_session (voice) ------------------------------------------------

  const endSession = tool(
    async (input) => {
      push(runtime, { type: 'end_session', ...(input.reason ? { reason: input.reason } : {}) });
      return 'Session will close after this reply.';
    },
    {
      name: 'end_session',
      description:
        'VOICE ONLY. Call after your closing line when the user says goodbye, "that\'s all", or asks to stop. Never call it in text chat.',
      schema: z.object({ reason: z.string().optional() }),
    },
  );

  return [
    logTransaction,
    getSpendingSummary,
    listTransactions,
    setBudget,
    getBudgetStatus,
    getSpendingTrend,
    deleteTransaction,
    scheduleReminder,
    navigateTo,
    endSession,
  ];
}

export type AgentTools = ReturnType<typeof buildTools>;
