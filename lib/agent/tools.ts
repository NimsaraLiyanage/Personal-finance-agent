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
import {
  buildBudgetStatus,
  buildFlowSeries,
  buildSpendingSummary,
  listBudgetStatuses,
  listTransactions as queryTransactions,
  toTransactionView,
  type LedgerScope,
} from '../finance/queries';
import { formatMoney, toMinor } from '../money';
import { rememberCategoryRule, resolveCategory } from '../finance/categories';
import type {
  BudgetStatus,
  PendingClientAction,
  ToolRuntime,
  TrendPoint,
} from './types';
import { formatDateInZone, nowInZone, parseOccurredAt, type PeriodKey } from './time';

// ── Shared schema fragments ─────────────────────────────────────────────────

// Free text, not an enum. Categories belong to the user (lib/finance/categories.ts),
// so the model is told the current set in the account snapshot and whatever it
// says is normalised server-side — which is also where a remembered correction
// gets to overrule it.
const CategoryEnum = z
  .string()
  .describe(
    'A category name. Prefer one listed in the account snapshot; only invent a new one when none of theirs fit.',
  );

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

function push(runtime: ToolRuntime, action: PendingClientAction): void {
  runtime.actions.push(action);
}

// ── Tool factory ────────────────────────────────────────────────────────────

export function buildTools(runtime: ToolRuntime) {
  const now = () => nowInZone(runtime.clientNow, runtime.timezone);
  const money = (minor: number) => formatMoney(minor, runtime.currency);

  // Every read goes through lib/finance/queries.ts on a scope built here, so
  // the agent and the dashboard answer the same question the same way.
  const scope = (): LedgerScope => ({
    userId: runtime.userId,
    currency: runtime.currency,
    timezone: runtime.timezone,
    now: now(),
  });

  // ---- log_transaction ----------------------------------------------------

  const logTransaction = tool(
    async (input) => {
      try {
        const at = parseOccurredAt(input.occurred_on, now(), runtime.timezone);
        const amountMinor = toMinor(input.amount, runtime.currency);
        if (amountMinor <= 0) {
          return 'Amount must be greater than zero. Ask the user to restate it.';
        }

        // A correction the user made earlier beats the model's guess. This is
        // the whole point of remembering them: they should not have to say
        // "that's transport, not other" about the same merchant twice.
        const category = await resolveCategory(runtime.userId, input.category, {
          merchant: input.merchant,
        });

        const created = await prisma.transaction.create({
          data: {
            userId: runtime.userId,
            kind: input.kind,
            amountMinor,
            currency: runtime.currency,
            merchant: input.merchant?.trim() || null,
            category,
            note: input.note?.trim() || null,
            occurredAt: at,
            source: input.source ?? 'chat',
          },
        });

        const view = toTransactionView(created);

        // If this spend touches a budgeted category, attach the updated status
        // so the card can show the bar moving — and so the model can mention an
        // overrun without a second tool call.
        let budgetTouched: BudgetStatus | undefined;
        if (input.kind === 'expense') {
          const budget = await prisma.budget.findUnique({
            where: { userId_category: { userId: runtime.userId, category } },
            select: { limitMinor: true },
          });
          if (budget) {
            budgetTouched = await buildBudgetStatus(scope(), category, budget.limitMinor);
          }
        }

        push(runtime, { type: 'transaction_logged', transaction: view, budgetTouched });

        const label = [view.merchant, view.category].filter(Boolean).join(', ');
        const base = `Logged ${input.kind}: ${view.formatted} (${label}) on ${formatDateInZone(at, runtime.timezone)}.`;
        if (budgetTouched?.state === 'over') {
          return `${base} This puts ${category} at ${budgetTouched.formattedSpent} against a ${budgetTouched.formattedLimit} budget — over by ${money(Math.abs(budgetTouched.remainingMinor))}.`;
        }
        if (budgetTouched?.state === 'warning') {
          return `${base} ${category} is now at ${Math.round(budgetTouched.usedRatio * 100)}% of its ${budgetTouched.formattedLimit} budget.`;
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
      const summary = await buildSpendingSummary(scope(), input.period as PeriodKey);
      push(runtime, { type: 'spending_summary', summary });

      if (summary.transactionCount === 0) {
        return `No transactions recorded for ${summary.periodLabel.toLowerCase()}.`;
      }
      const top = summary.byCategory
        .slice(0, 3)
        .map((c) => `${c.category} ${c.formatted}`)
        .join(', ');
      const delta =
        summary.changePct === null
          ? ''
          : ` That is ${Math.abs(Math.round(summary.changePct * 100))}% ${summary.changePct >= 0 ? 'more than' : 'less than'} the previous period.`;
      return `${summary.periodLabel}: spent ${summary.formattedSpent} across ${summary.transactionCount} transactions. Top: ${top}.${delta}`;
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
      const filterCategory = input.category
        ? await resolveCategory(runtime.userId, input.category, { create: false })
        : undefined;

      const { transactions, periodLabel } = await queryTransactions(scope(), {
        period: (input.period ?? 'this_month') as PeriodKey,
        category: filterCategory,
        merchantContains: input.merchant_contains,
        limit: Math.min(input.limit ?? 20, 50),
      });

      const heading = [
        input.category ? `${input.category} transactions` : 'Transactions',
        periodLabel.toLowerCase(),
      ].join(' — ');

      push(runtime, { type: 'transaction_list', transactions, heading });

      if (transactions.length === 0) {
        return `No matching transactions for ${periodLabel.toLowerCase()}.`;
      }
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

      const category = await resolveCategory(runtime.userId, input.category);
      const saved = await prisma.budget.upsert({
        where: { userId_category: { userId: runtime.userId, category } },
        create: {
          userId: runtime.userId,
          category,
          limitMinor,
          currency: runtime.currency,
        },
        update: { limitMinor, currency: runtime.currency },
      });

      const status = await buildBudgetStatus(scope(), saved.category, saved.limitMinor);
      push(runtime, { type: 'budget_saved', budget: status });

      return `Budget set: ${money(limitMinor)} per month for ${category}. Already spent ${status.formattedSpent} this month.`;
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
      const filterCategory = input.category
        ? await resolveCategory(runtime.userId, input.category, { create: false })
        : undefined;
      const statuses = await listBudgetStatuses(scope(), filterCategory);

      if (statuses.length === 0) {
        push(runtime, { type: 'budget_status', budgets: [] });
        return input.category
          ? `No budget set for ${input.category}. Offer to create one.`
          : 'No budgets set yet. Offer to create one.';
      }

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
      const granularity = input.granularity ?? 'month';
      const filterCategory = input.category
        ? await resolveCategory(runtime.userId, input.category, { create: false })
        : undefined;
      const series = await buildFlowSeries(scope(), {
        granularity,
        buckets: input.buckets ?? 6,
        category: filterCategory,
      });

      // The card plots spend only; the flow series carries income too, which
      // the dashboard uses and this chart deliberately does not.
      const points: TrendPoint[] = series.map((p) => ({
        label: p.label,
        totalMinor: p.expenseMinor,
        formatted: p.formattedExpense,
      }));

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
      const view = toTransactionView(target);
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

  // ---- recategorize_transaction -------------------------------------------

  const recategorizeTransaction = tool(
    async (input) => {
      const target = input.transaction_id
        ? await prisma.transaction.findFirst({
            where: { id: input.transaction_id, userId: runtime.userId },
          })
        : await prisma.transaction.findFirst({
            where: { userId: runtime.userId },
            orderBy: { createdAt: 'desc' },
          });

      if (!target) return 'There is no matching transaction to recategorise.';

      // create: true — "call it groceries" about something with no matching
      // category is a request to have that category, not an error.
      const category = await resolveCategory(runtime.userId, input.category, { create: true });

      const updated = await prisma.transaction.update({
        where: { id: target.id },
        data: { category },
      });

      // The correction is the valuable part. Remembering it is what stops the
      // same fix being needed every week — see CategoryRule in the schema.
      let remembered: string | null = null;
      const pattern = input.remember_for?.trim() || target.merchant?.trim() || null;
      if (input.remember !== false && pattern) {
        const ok = await rememberCategoryRule(runtime.userId, pattern, category);
        if (ok) remembered = pattern.toLowerCase();
      }

      push(runtime, { type: 'transaction_logged', transaction: toTransactionView(updated) });

      const base = `Moved ${formatMoney(updated.amountMinor, updated.currency)} from ${target.category} to ${category}.`;
      return remembered
        ? `${base} From now on anything matching "${remembered}" goes to ${category} automatically — tell the user you'll remember it, in a short clause.`
        : base;
    },
    {
      name: 'recategorize_transaction',
      description: [
        'Fix the category on a transaction, and remember the correction.',
        'Use whenever the user disagrees with a category — "no, that\'s transport",',
        '"Uber is not shopping", "put the kade one under groceries".',
        'With no id it fixes the most recently created transaction, which is almost',
        'always what "no, that one" means.',
        'This is how the assistant learns their vocabulary: prefer it over silently',
        'guessing better next time.',
      ].join(' '),
      schema: z.object({
        category: CategoryEnum.describe('What it should have been.'),
        transaction_id: z
          .string()
          .optional()
          .describe('Omit to fix the most recently created transaction.'),
        remember: z
          .boolean()
          .optional()
          .describe('Default true. Set false only if the user says this time is an exception.'),
        remember_for: z
          .string()
          .optional()
          .describe(
            'The word or merchant the rule should key on, if different from the transaction\'s merchant — e.g. "bus eka", "kade".',
          ),
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

      // Says where it will actually show up. The model used to be free to
      // imply a phone notification, which nothing in this app sends.
      return `Reminder saved for ${dueAt.toISOString()}: ${input.title}. It appears on their dashboard when it comes due and stays there until they mark it done.`;
    },
    {
      name: 'schedule_reminder',
      description: [
        'Schedule a nudge — a bill due, a savings check-in, a "review your dining spend on Sunday".',
        'Give either in_minutes or due_at, not both.',
        'Delivery is in-app: it surfaces on their dashboard when due. Do not tell them',
        'their phone will alert them.',
      ].join(' '),
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
    recategorizeTransaction,
    scheduleReminder,
    navigateTo,
    endSession,
  ];
}

export type AgentTools = ReturnType<typeof buildTools>;
