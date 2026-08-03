// Reminder delivery.
//
// `schedule_reminder` has always written rows; until this module existed
// nothing ever read them, so the agent was promising something the app never
// did. That is worse than not having reminders at all — it teaches people the
// assistant's promises don't mean anything.
//
// Delivery is in-app for now: a due reminder surfaces on the dashboard and
// stays there until the person acknowledges it. Push notification delivery
// (see the PWA work) will call these same functions rather than reimplementing
// the query.

import { prisma } from '../db';
import type { LedgerScope } from './queries';

export interface ReminderView {
  id: string;
  title: string;
  body: string;
  category: string;
  dueAt: string;
  /** Due now or in the past — the reminder is asking for attention. */
  due: boolean;
}

function toView(
  r: { id: string; title: string; body: string; category: string; dueAt: Date },
  now: Date,
): ReminderView {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    category: r.category,
    dueAt: r.dueAt.toISOString(),
    due: r.dueAt.getTime() <= now.getTime(),
  };
}

/**
 * Everything still waiting, split by whether it has come due.
 *
 * "Waiting" means `firedAt` is null. That column is set when the person
 * *acknowledges* a reminder, not when it is first rendered: a reminder shown
 * once on a day nobody opened the app would otherwise be silently consumed,
 * which is exactly the failure this module exists to fix.
 */
export async function listActiveReminders(
  scope: LedgerScope,
  options: { upcomingLimit?: number } = {},
): Promise<{ due: ReminderView[]; upcoming: ReminderView[] }> {
  const rows = await prisma.reminder.findMany({
    where: { userId: scope.userId, firedAt: null },
    orderBy: { dueAt: 'asc' },
    select: { id: true, title: true, body: true, category: true, dueAt: true },
  });

  const views = rows.map((r) => toView(r, scope.now));
  return {
    due: views.filter((v) => v.due),
    upcoming: views.filter((v) => !v.due).slice(0, options.upcomingLimit ?? 4),
  };
}

/** Mark a reminder as delivered and acted on. Scoped, so a guessed id matches nothing. */
export async function acknowledgeReminder(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.reminder.updateMany({
    where: { id, userId, firedAt: null },
    data: { firedAt: new Date() },
  });
  return count > 0;
}

export async function deleteReminder(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.reminder.deleteMany({ where: { id, userId } });
  return count > 0;
}
