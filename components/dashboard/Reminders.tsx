'use client';

import { useState, useTransition } from 'react';

import { dismissReminder, removeReminder } from '@/app/actions/finance';
import type { ReminderView } from '@/lib/finance/reminders';

// Two surfaces, because a reminder that has come due and one that hasn't are
// different things. Due ones interrupt — they sit above everything else and
// stay until acknowledged. Upcoming ones are just a quiet list.

export function DueReminders({
  reminders,
  timezone,
}: {
  reminders: ReminderView[];
  timezone: string;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const act = (id: string, fn: (id: string) => Promise<unknown>) => {
    setPendingId(id);
    startTransition(async () => {
      await fn(id);
      setPendingId(null);
    });
  };

  if (reminders.length === 0) return null;

  return (
    <section
      aria-label="Reminders due"
      className="rounded-2xl border border-warn/35 bg-warn/8 p-4"
    >
      <h2 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-warn">
        <span aria-hidden>⏰</span>
        {reminders.length === 1 ? 'A reminder is due' : `${reminders.length} reminders are due`}
      </h2>

      <ul className="space-y-2.5">
        {reminders.map((r) => (
          <li
            key={r.id}
            className={`flex flex-wrap items-start gap-3 rounded-xl border border-line bg-surface p-3 transition-opacity ${
              pendingId === r.id ? 'opacity-40' : ''
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{r.title}</div>
              <div className="text-xs leading-relaxed text-ink-dim">{r.body}</div>
              <div className="mt-0.5 text-[11px] text-ink-faint">{when(r, timezone)}</div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => act(r.id, dismissReminder)}
                disabled={pendingId === r.id}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
              >
                Done
              </button>
              <button
                type="button"
                onClick={() => act(r.id, removeReminder)}
                disabled={pendingId === r.id}
                aria-label={`Delete the reminder "${r.title}"`}
                className="rounded-lg px-2 py-1.5 text-xs text-ink-faint transition-colors hover:text-danger disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function UpcomingReminders({
  reminders,
  timezone,
}: {
  reminders: ReminderView[];
  timezone: string;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (reminders.length === 0) return null;

  return (
    <section className="card p-4">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-faint">Coming up</h2>
      <ul className="space-y-2.5">
        {reminders.map((r) => (
          <li
            key={r.id}
            className={`group flex items-start gap-2 ${pendingId === r.id ? 'opacity-40' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink-dim">{r.title}</div>
              <div className="text-[11px] text-ink-faint">{when(r, timezone)}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                setPendingId(r.id);
                startTransition(async () => {
                  await removeReminder(r.id);
                  setPendingId(null);
                });
              }}
              aria-label={`Delete the reminder "${r.title}"`}
              className="shrink-0 rounded px-1 text-xs text-ink-faint opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Today at 3:00 PM" / "Overdue since Aug 1" / "Fri, Aug 7". */
function when(reminder: ReminderView, timezone: string): string {
  const at = new Date(reminder.dueAt);
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  }).format(at);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(at);

  return reminder.due ? `Was due ${date}, ${time}` : `${date}, ${time}`;
}
