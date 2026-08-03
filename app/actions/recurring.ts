'use server';

// Recurring charges: rescan, and the three things a person can say about one.
//
// Detection is a suggestion. "I cancelled that" and "stop showing me this" are
// facts, and they have to stick — an app that keeps rediscovering a gym
// membership someone quit in March is one they stop trusting about anything.

import { revalidatePath } from 'next/cache';

import {
  forgetRecurring,
  refreshRecurring,
  setRecurringStatus,
  type RecurringStatus,
} from '@/lib/finance/recurring';
import type { LedgerScope } from '@/lib/finance/queries';
import { resolveUser } from '@/lib/session';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Better Auth issues its own cookie via the `nextCookies` plugin. */
async function session() {
  return resolveUser();
}

function refresh() {
  revalidatePath('/');
}

export async function rescanRecurring(): Promise<
  ActionResult & { found?: number; added?: number; priceChanges?: number }
> {
  const { userId, currency, timezone } = await session();
  const scope: LedgerScope = { userId, currency, timezone, now: new Date() };

  try {
    const result = await refreshRecurring(scope);
    refresh();
    return { ok: true, ...result };
  } catch (err) {
    console.error('[recurring] rescan failed:', err);
    return { ok: false, error: 'Could not scan for repeating charges.' };
  }
}

export async function markRecurring(id: string, status: RecurringStatus): Promise<ActionResult> {
  const { userId } = await session();
  const ok = await setRecurringStatus(userId, id, status);
  if (!ok) return { ok: false, error: 'That charge is no longer listed.' };
  refresh();
  return { ok: true };
}

/** "This was never a subscription." Removes it outright; a rescan may re-find it. */
export async function dismissRecurring(id: string): Promise<ActionResult> {
  const { userId } = await session();
  await forgetRecurring(userId, id);
  refresh();
  return { ok: true };
}
