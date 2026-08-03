'use client';

// Renders one PendingClientAction.
//
// The switch is exhaustive by construction: the `never` in the default branch
// means adding a variant to the union without handling it here is a type
// error, not a card that silently fails to appear.

import type { BudgetStatus, PendingClientAction, TrendPoint } from '@/lib/agent/types';

export default function ActionCard({ action }: { action: PendingClientAction }) {
  switch (action.type) {
    case 'transaction_logged':
      return (
        <Shell>
          <TransactionRow t={action.transaction} />
          {action.budgetTouched && (
            <div className="mt-3 border-t border-line pt-3">
              <BudgetBar budget={action.budgetTouched} />
            </div>
          )}
        </Shell>
      );

    case 'transactions_logged':
      return (
        <Shell>
          <div className="divide-y divide-line">
            {action.transactions.map((t) => (
              <div key={t.id} className="py-2 first:pt-0 last:pb-0">
                <TransactionRow t={t} />
              </div>
            ))}
          </div>
        </Shell>
      );

    case 'spending_summary': {
      const s = action.summary;
      return (
        <Shell title={s.periodLabel}>
          <div className="flex items-baseline gap-4">
            <div>
              <div className="text-2xl font-semibold tracking-tight tnum">{s.formattedSpent}</div>
              <div className="text-xs text-ink-faint">
                spent · {s.transactionCount} transactions
              </div>
            </div>
            {s.changePct !== null && (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium tnum ${
                  s.changePct > 0 ? 'bg-danger/10 text-danger' : 'bg-accent-soft text-accent'
                }`}
              >
                {s.changePct > 0 ? '▲' : '▼'} {Math.abs(Math.round(s.changePct * 100))}%
              </span>
            )}
          </div>

          {s.byCategory.length > 0 && (
            <div className="mt-4 space-y-2">
              {s.byCategory.slice(0, 6).map((c) => (
                <div key={c.category} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0 truncate text-ink-dim">{c.category}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${Math.max(2, c.share * 100)}%` }}
                    />
                  </span>
                  <span className="w-20 shrink-0 text-right tnum">{c.formatted}</span>
                </div>
              ))}
            </div>
          )}
        </Shell>
      );
    }

    case 'transaction_list':
      return (
        <Shell title={action.heading}>
          {action.transactions.length === 0 ? (
            <Empty>Nothing here.</Empty>
          ) : (
            <div className="divide-y divide-line">
              {action.transactions.map((t) => (
                <div key={t.id} className="py-2 first:pt-0 last:pb-0">
                  <TransactionRow t={t} />
                </div>
              ))}
            </div>
          )}
        </Shell>
      );

    case 'budget_status':
      return (
        <Shell title="Budgets">
          {action.budgets.length === 0 ? (
            <Empty>No budgets set yet.</Empty>
          ) : (
            <div className="space-y-3">
              {action.budgets.map((b) => (
                <BudgetBar key={b.category} budget={b} />
              ))}
            </div>
          )}
        </Shell>
      );

    case 'budget_saved':
      return (
        <Shell title="Budget updated">
          <BudgetBar budget={action.budget} />
        </Shell>
      );

    case 'trend_chart':
      return (
        <Shell title={action.title}>
          <TrendChart points={action.points} />
        </Shell>
      );

    case 'reminder_scheduled':
      return (
        <Shell>
          <div className="flex items-start gap-3">
            <span aria-hidden className="mt-0.5 text-lg">
              ⏰
            </span>
            <div>
              <div className="text-sm font-medium">{action.title}</div>
              <div className="text-xs text-ink-dim">{action.body}</div>
              <div className="mt-1 text-xs text-ink-faint tnum">
                {action.when.kind === 'relative'
                  ? `in ${action.when.offsetMinutes} min`
                  : new Date(action.when.isoDatetime).toLocaleString()}
              </div>
            </div>
          </div>
        </Shell>
      );

    case 'navigate':
      // Screens beyond chat aren't built in this slice; surfacing the intent
      // keeps the action visible rather than swallowing it.
      return (
        <Shell>
          <div className="text-sm text-ink-dim">
            Opening <span className="text-ink">{action.screen}</span>
          </div>
        </Shell>
      );

    case 'end_session':
      return null;

    default: {
      const exhaustive: never = action;
      void exhaustive;
      return null;
    }
  }
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Shell({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="card animate-rise p-4">
      {title && (
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-sm text-ink-faint">{children}</div>;
}

function TransactionRow({ t }: { t: import('@/lib/agent/types').TransactionView }) {
  const income = t.kind === 'income';
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className={`grid size-8 shrink-0 place-items-center rounded-full text-xs ${
          income ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-dim'
        }`}
      >
        {income ? '↓' : '↑'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{t.merchant ?? t.category}</div>
        <div className="text-xs text-ink-faint">
          {t.category} · {new Date(t.occurredAt).toLocaleDateString()}
        </div>
      </div>
      <div className={`shrink-0 text-sm font-medium tnum ${income ? 'text-accent' : ''}`}>
        {income ? '+' : ''}
        {t.formatted}
      </div>
    </div>
  );
}

function BudgetBar({ budget }: { budget: BudgetStatus }) {
  const pct = Math.min(100, Math.round(budget.usedRatio * 100));
  const colour =
    budget.state === 'over' ? 'bg-danger' : budget.state === 'warning' ? 'bg-warn' : 'bg-accent';

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="text-ink-dim">{budget.category}</span>
        <span className="tnum text-xs text-ink-faint">
          {budget.formattedSpent} / {budget.formattedLimit}
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-line">
        <span
          className={`block h-full rounded-full ${colour} transition-[width] duration-500`}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
        {/* Where spending *should* be by this point in the month. A bar at 60%
            on the 5th is a very different story than on the 28th. */}
        <span
          className="absolute inset-y-0 w-px bg-ink/45"
          style={{ left: `${Math.round(budget.monthProgress * 100)}%` }}
          title="Expected pace for today"
        />
      </div>
      <div className="mt-1 text-xs tnum text-ink-faint">
        {budget.state === 'over'
          ? `Over by ${budget.formattedRemaining.replace('-', '')}`
          : `${budget.formattedRemaining} left`}
      </div>
    </div>
  );
}

function TrendChart({ points }: { points: TrendPoint[] }) {
  const max = Math.max(...points.map((p) => p.totalMinor), 1);
  return (
    <div>
      <div className="flex h-28 items-end gap-1.5">
        {points.map((p, i) => (
          <div key={`${p.label}-${i}`} className="group flex flex-1 flex-col items-center gap-1">
            <span className="w-full text-center text-[10px] tnum text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
              {p.formatted}
            </span>
            <span
              className="w-full rounded-t bg-accent-dim transition-colors group-hover:bg-accent"
              style={{ height: `${Math.max(2, (p.totalMinor / max) * 100)}%` }}
              title={`${p.label}: ${p.formatted}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        {points.map((p, i) => (
          <span key={`${p.label}-label-${i}`} className="flex-1 text-center text-[10px] text-ink-faint">
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}
