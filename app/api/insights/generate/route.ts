// POST /api/insights/generate — write this week's briefings.
//
// Meant for a scheduler (Vercel Cron, GitHub Actions, cron-job.org — anything
// that can send a header). It is the one route in the app that acts for every
// user rather than the caller, so it is gated on a shared secret rather than a
// session: a cron job has no cookie, and a session must never be able to make
// the server do work for somebody else's account.

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { prisma } from '@/lib/db';
import { generateWeeklyBriefing } from '@/lib/insights/briefing';
import { refreshRecurring } from '@/lib/finance/recurring';
import type { LedgerScope } from '@/lib/finance/queries';

export const runtime = 'nodejs';
// Several users × one model call each; well past a default serverless window.
export const maxDuration = 300;

/** Users worth briefing: ones who have logged something recently. */
const ACTIVE_WINDOW_DAYS = 14;

function authorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;

  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!authorised(request)) {
    // Same response whether the secret is wrong or unset — no probing.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const since = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86_400_000);
  const active = await prisma.user.findMany({
    where: { transactions: { some: { occurredAt: { gte: since } } } },
    select: { id: true, currency: true, timezone: true },
  });

  const results: Array<{ userId: string; status: 'written' | 'skipped' | 'failed' }> = [];
  let scanned = 0;

  for (const user of active) {
    const scope: LedgerScope = {
      userId: user.id,
      currency: user.currency,
      timezone: user.timezone,
      now: new Date(),
    };

    try {
      // Detection first, briefing second — the briefing reads the recurring
      // model, so a scan that ran afterwards would be a week too late to be
      // mentioned. A failure here must not cost them the briefing itself.
      try {
        await refreshRecurring(scope);
        scanned++;
      } catch (err) {
        console.error('[insights] recurring scan failed', user.id, (err as Error).message);
      }

      const briefing = await generateWeeklyBriefing(scope);
      results.push({ userId: user.id, status: briefing ? 'written' : 'skipped' });
    } catch (err) {
      // One user's failure must not abort the run for everyone after them.
      console.error('[insights] briefing failed', user.id, (err as Error).message);
      results.push({ userId: user.id, status: 'failed' });
    }
  }

  return NextResponse.json({
    considered: active.length,
    scanned,
    written: results.filter((r) => r.status === 'written').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
  });
}
