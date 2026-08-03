'use server';

// Briefing actions for the person reading their own dashboard.
//
// Separate from the cron route on purpose: that route acts for every user and
// is gated on a shared secret; these act only for the caller and are gated on
// their session. Mixing the two is how an endpoint ends up doing work for an
// account the caller doesn't own.

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

import { resolveUser, SESSION_COOKIE } from '@/lib/session';
import { generateWeeklyBriefing, markInsightRead } from '@/lib/insights/briefing';
import type { LedgerScope } from '@/lib/finance/queries';

export interface InsightActionResult {
  ok: boolean;
  error?: string;
  /** True when there was nothing worth writing about. */
  quiet?: boolean;
}

async function session() {
  const resolved = await resolveUser();
  if (resolved.setCookie) {
    const jar = await cookies();
    jar.set(SESSION_COOKIE.name, resolved.setCookie, SESSION_COOKIE.options);
  }
  return resolved;
}

/** Write this week's briefing if it doesn't exist yet. */
export async function refreshBriefing(): Promise<InsightActionResult> {
  const { userId, currency, timezone } = await session();
  const scope: LedgerScope = { userId, currency, timezone, now: new Date() };

  try {
    const briefing = await generateWeeklyBriefing(scope);
    revalidatePath('/');
    if (!briefing) return { ok: true, quiet: true };
    return { ok: true };
  } catch (err) {
    // Usually a missing or rejected API key. Surface it rather than leaving a
    // button that appears to do nothing.
    return { ok: false, error: (err as Error).message };
  }
}

export async function dismissBriefing(id: string): Promise<InsightActionResult> {
  const { userId } = await session();
  await markInsightRead(userId, id);
  revalidatePath('/');
  return { ok: true };
}
