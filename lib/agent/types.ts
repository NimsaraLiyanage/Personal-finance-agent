// Agent-core types.
//
// `PendingClientAction` is the heart of the architecture: a typed, discriminated
// union of directives the server sends to the client after a turn. The model
// never emits UI — it calls a tool, the tool executor pushes a typed action,
// and the client renders a known component for that action type.
//
// Why this over "let the model return markdown/JSON for the UI":
//   - The model cannot invent a card shape the client can't render.
//   - Adding a card is a compile error until every branch handles it.
//   - The same action set can drive a web client, an iOS client, or a CLI —
//     each decides how to render, none re-parses prose.

export const CATEGORIES = [
  'groceries',
  'dining',
  'transport',
  'housing',
  'utilities',
  'health',
  'entertainment',
  'shopping',
  'education',
  'subscriptions',
  'savings',
  'income',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

// ── Domain shapes returned by tools ─────────────────────────────────────────

export interface TransactionView {
  id: string;
  kind: 'expense' | 'income';
  amountMinor: number;
  currency: string;
  formatted: string;
  merchant: string | null;
  category: Category;
  note: string | null;
  occurredAt: string;
  /** Half of a move between the user's own accounts — neither in nor out. */
  transfer: boolean;
  accountId: string | null;
  accountName: string | null;
}

export interface CategoryTotal {
  category: Category;
  totalMinor: number;
  formatted: string;
  /** Share of the period's total spend, 0–1. */
  share: number;
  count: number;
}

export interface SpendingSummary {
  periodLabel: string;
  from: string;
  to: string;
  currency: string;
  totalSpentMinor: number;
  totalIncomeMinor: number;
  netMinor: number;
  formattedSpent: string;
  formattedIncome: string;
  formattedNet: string;
  transactionCount: number;
  byCategory: CategoryTotal[];
  /** Same window, previous period — null when there's no prior data. */
  previousTotalSpentMinor: number | null;
  changePct: number | null;
}

export interface BudgetStatus {
  category: Category;
  limitMinor: number;
  spentMinor: number;
  remainingMinor: number;
  formattedLimit: string;
  formattedSpent: string;
  formattedRemaining: string;
  /** Spent / limit. Can exceed 1 when over budget. */
  usedRatio: number;
  state: 'ok' | 'warning' | 'over';
  /** Straight-line pace: where usedRatio *should* be this far into the month. */
  monthProgress: number;
}

export interface TrendPoint {
  label: string;
  totalMinor: number;
  formatted: string;
}

export type ScreenName = 'dashboard' | 'transactions' | 'budgets' | 'insights';

export type ReminderWhen =
  | { kind: 'relative'; offsetMinutes: number }
  | { kind: 'absolute'; isoDatetime: string };

// ── The directive union ─────────────────────────────────────────────────────

export type PendingClientAction =
  /** A transaction was written. Card shows it and offers undo / recategorize. */
  | { type: 'transaction_logged'; transaction: TransactionView; budgetTouched?: BudgetStatus }
  /** Several written in one turn ("coffee 4.50 and lunch 12"). */
  | { type: 'transactions_logged'; transactions: TransactionView[] }
  | { type: 'spending_summary'; summary: SpendingSummary }
  | { type: 'transaction_list'; transactions: TransactionView[]; heading: string }
  | { type: 'budget_status'; budgets: BudgetStatus[] }
  | { type: 'budget_saved'; budget: BudgetStatus }
  /** Time series for the chart card (monthly/weekly/daily spend). */
  | { type: 'trend_chart'; title: string; points: TrendPoint[]; currency: string }
  | { type: 'navigate'; screen: ScreenName }
  | {
      type: 'reminder_scheduled';
      title: string;
      body: string;
      when: ReminderWhen;
      category: string;
      dedupeKey?: string;
    }
  /** Voice only: the user said goodbye; the client tears the session down. */
  | { type: 'end_session'; reason?: string };

// ── Turn plumbing ───────────────────────────────────────────────────────────

export interface AgentToolEvent {
  toolName: string;
  args: unknown;
  result: unknown;
}

export interface ChatTurnResult {
  threadId: string;
  assistantText: string;
  pendingClientActions: PendingClientAction[];
  toolEvents: AgentToolEvent[];
}

/** Per-turn execution context handed to every tool executor. */
export interface ToolRuntime {
  userId: string;
  threadId: string;
  currency: string;
  timezone: string;
  /** The client's wall clock, so "yesterday" resolves in the user's day. */
  clientNow?: string;
  /** Tools push directives here; the route drains it after the turn. */
  actions: PendingClientAction[];
}

export function createToolRuntime(
  args: Omit<ToolRuntime, 'actions'> & { actions?: PendingClientAction[] },
): ToolRuntime {
  return { ...args, actions: args.actions ?? [] };
}

// ── SSE wire protocol ───────────────────────────────────────────────────────
// One event per line-delimited JSON frame. `token` frames stream prose as it
// is generated; `action` frames arrive the moment a tool finishes, so a card
// can render before the model has finished writing its sentence.

export type StreamEvent =
  | { type: 'thread'; threadId: string }
  | { type: 'token'; delta: string }
  | { type: 'tool_start'; toolName: string }
  | { type: 'action'; action: PendingClientAction }
  | { type: 'done'; assistantText: string }
  | { type: 'error'; message: string };
