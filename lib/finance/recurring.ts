// Recurring charges — finding them, and noticing when they change.
//
// The retention case for a finance app is not "here is what you spent". People
// already know roughly what they spent. It is "you are still paying Rs 1,500 a
// month for something you stopped using in March", which nobody knows, because
// the whole design of a subscription is that you stop noticing it.
//
// Detection is deliberately conservative. A false positive here is worse than a
// miss: telling someone they have a subscription they do not have makes every
// other number look like a guess. So a charge is only recurring when it has
// happened at least three times, on a rhythm we can name, at a stable amount.
//
// Nothing detected is treated as fact. A row is a suggestion the person can
// cancel, pause, or leave alone.

import { prisma } from '../db';
import { formatMoney } from '../money';
import { EXCLUDE_TRANSFERS, type LedgerScope } from './queries';

export type Cadence = 'weekly' | 'monthly' | 'yearly';
export type RecurringStatus = 'active' | 'paused' | 'cancelled';

const DAY = 86_400_000;

/** Expected gap, and how far off a real gap may be and still count. */
const CADENCES: Array<{ cadence: Cadence; days: number; tolerance: number }> = [
  { cadence: 'weekly', days: 7, tolerance: 2 },
  { cadence: 'monthly', days: 30.44, tolerance: 6 },
  { cadence: 'yearly', days: 365.25, tolerance: 30 },
];

/** How far back detection looks. Long enough to see a yearly charge twice. */
const LOOKBACK_DAYS = 400;

/** Charges needed before we will call something recurring. */
const MIN_OCCURRENCES = 3;

/**
 * How much the amount may drift and still be the same subscription.
 *
 * Not zero: prices change, and a utility bill is never the same twice. Too
 * loose and every trip to the same shop becomes a "subscription".
 */
const AMOUNT_DRIFT = 0.25;

export interface RecurringView {
  id: string;
  merchant: string;
  amountMinor: number;
  formattedAmount: string;
  category: string;
  cadence: Cadence;
  status: RecurringStatus;
  source: string;
  occurrences: number;
  lastSeenAt: string;
  nextDueAt: string;
  /** Normalised so a yearly and a weekly charge can sit in one total. */
  monthlyEquivalentMinor: number;
  formattedMonthly: string;
  /** Set when the amount moved since we last looked. */
  priceChange: { fromMinor: number; toMinor: number; formatted: string; at: string } | null;
  /** Days past the expected date. Negative means still to come. */
  overdueDays: number;
}

/** Weekly and yearly charges converted to what they cost per month. */
export function monthlyEquivalent(amountMinor: number, cadence: Cadence): number {
  if (cadence === 'weekly') return Math.round((amountMinor * 52) / 12);
  if (cadence === 'yearly') return Math.round(amountMinor / 12);
  return amountMinor;
}

/** The key charges are grouped on. Case and spacing are noise. */
export function matchKeyFor(merchant: string): string {
  return merchant.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

function cadenceDays(cadence: Cadence): number {
  return CADENCES.find((c) => c.cadence === cadence)!.days;
}

/** Median, which shrugs off the one charge that landed a week late. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Name the rhythm, or admit there isn't one. */
function classifyCadence(gapsInDays: number[]): Cadence | null {
  if (gapsInDays.length === 0) return null;
  const typical = median(gapsInDays);
  for (const { cadence, days, tolerance } of CADENCES) {
    if (Math.abs(typical - days) <= tolerance) return cadence;
  }
  return null;
}

// ── Detection ───────────────────────────────────────────────────────────────

interface Candidate {
  merchant: string;
  matchKey: string;
  amountMinor: number;
  category: string;
  cadence: Cadence;
  occurrences: number;
  lastSeenAt: Date;
}

/**
 * Scan the ledger and return what looks recurring.
 *
 * Pure-ish: reads, decides, returns. The writing is separate so the rules can
 * be tested without a round trip through the database.
 */
export async function findCandidates(scope: LedgerScope): Promise<Candidate[]> {
  const from = new Date(scope.now.getTime() - LOOKBACK_DAYS * DAY);

  const rows = await prisma.transaction.findMany({
    where: {
      userId: scope.userId,
      kind: 'expense',
      merchant: { not: null },
      occurredAt: { gte: from },
      // Moving your own money on a schedule is not a subscription.
      ...EXCLUDE_TRANSFERS,
    },
    orderBy: { occurredAt: 'asc' },
    select: { merchant: true, amountMinor: true, category: true, occurredAt: true },
  });

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = matchKeyFor(row.merchant!);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const candidates: Candidate[] = [];

  for (const [matchKey, charges] of groups) {
    if (charges.length < MIN_OCCURRENCES) continue;

    // The latest amount is the one that matters — it is what they pay now.
    const latest = charges[charges.length - 1];

    // Keep only charges close to the current amount. A merchant billed monthly
    // at a steady price, with the odd one-off purchase mixed in, should still
    // be found; a shop visited at wildly different amounts should not.
    const consistent = charges.filter(
      (c) => Math.abs(c.amountMinor - latest.amountMinor) <= latest.amountMinor * AMOUNT_DRIFT,
    );
    if (consistent.length < MIN_OCCURRENCES) continue;

    const gaps: number[] = [];
    for (let i = 1; i < consistent.length; i++) {
      gaps.push((consistent[i].occurredAt.getTime() - consistent[i - 1].occurredAt.getTime()) / DAY);
    }

    const cadence = classifyCadence(gaps);
    if (!cadence) continue;

    candidates.push({
      merchant: latest.merchant!.trim().slice(0, 80),
      matchKey,
      amountMinor: latest.amountMinor,
      category: latest.category,
      cadence,
      occurrences: consistent.length,
      lastSeenAt: latest.occurredAt,
    });
  }

  return candidates;
}

/**
 * Detect and persist.
 *
 * Updates rather than replaces, so a price change lands on the existing row and
 * a cancelled subscription is not rediscovered next week — the whole value of
 * this model is that it remembers what it said last time.
 */
export async function refreshRecurring(scope: LedgerScope): Promise<{
  found: number;
  added: number;
  priceChanges: number;
}> {
  const candidates = await findCandidates(scope);
  let added = 0;
  let priceChanges = 0;

  for (const candidate of candidates) {
    const existing = await prisma.recurring.findUnique({
      where: {
        userId_matchKey_cadence: {
          userId: scope.userId,
          matchKey: candidate.matchKey,
          cadence: candidate.cadence,
        },
      },
    });

    const nextDueAt = new Date(candidate.lastSeenAt.getTime() + cadenceDays(candidate.cadence) * DAY);

    if (!existing) {
      await prisma.recurring.create({
        data: {
          userId: scope.userId,
          merchant: candidate.merchant,
          matchKey: candidate.matchKey,
          amountMinor: candidate.amountMinor,
          currency: scope.currency,
          category: candidate.category,
          cadence: candidate.cadence,
          lastSeenAt: candidate.lastSeenAt,
          nextDueAt,
          occurrences: candidate.occurrences,
          status: 'active',
          source: 'detected',
        },
      });
      added++;
      continue;
    }

    // Cancelled means cancelled. If charges are still arriving that is worth
    // saying out loud, but it is not licence to quietly resurrect the row.
    if (existing.status === 'cancelled' && existing.lastSeenAt >= candidate.lastSeenAt) continue;

    const amountMoved = existing.amountMinor !== candidate.amountMinor;
    if (amountMoved) priceChanges++;

    await prisma.recurring.update({
      where: { id: existing.id },
      data: {
        merchant: candidate.merchant,
        amountMinor: candidate.amountMinor,
        category: candidate.category,
        lastSeenAt: candidate.lastSeenAt,
        nextDueAt,
        occurrences: candidate.occurrences,
        ...(amountMoved
          ? { previousAmountMinor: existing.amountMinor, priceChangedAt: candidate.lastSeenAt }
          : {}),
      },
    });
  }

  return { found: candidates.length, added, priceChanges };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function listRecurring(
  scope: LedgerScope,
  options: { includeCancelled?: boolean } = {},
): Promise<RecurringView[]> {
  const rows = await prisma.recurring.findMany({
    where: {
      userId: scope.userId,
      ...(options.includeCancelled ? {} : { status: { not: 'cancelled' as const } }),
    },
    orderBy: [{ status: 'asc' }, { nextDueAt: 'asc' }],
  });

  return rows.map((row) => {
    const cadence = row.cadence as Cadence;
    const monthlyMinor = monthlyEquivalent(row.amountMinor, cadence);

    return {
      id: row.id,
      merchant: row.merchant,
      amountMinor: row.amountMinor,
      formattedAmount: formatMoney(row.amountMinor, row.currency),
      category: row.category,
      cadence,
      status: row.status as RecurringStatus,
      source: row.source,
      occurrences: row.occurrences,
      lastSeenAt: row.lastSeenAt.toISOString(),
      nextDueAt: row.nextDueAt.toISOString(),
      monthlyEquivalentMinor: monthlyMinor,
      formattedMonthly: formatMoney(monthlyMinor, row.currency),
      priceChange:
        row.previousAmountMinor !== null && row.priceChangedAt
          ? {
              fromMinor: row.previousAmountMinor,
              toMinor: row.amountMinor,
              formatted: `${formatMoney(row.previousAmountMinor, row.currency)} → ${formatMoney(row.amountMinor, row.currency)}`,
              at: row.priceChangedAt.toISOString(),
            }
          : null,
      overdueDays: Math.floor((scope.now.getTime() - row.nextDueAt.getTime()) / DAY),
    };
  });
}

/**
 * What they are committed to per month, and what is worth saying about it.
 *
 * `stale` is the one people care about: a charge that was arriving reliably and
 * then stopped. Usually it means they cancelled and forgot to say so — but it
 * can also mean a card expired and a service is about to be cut off, which is
 * exactly the kind of thing worth a sentence.
 */
export async function recurringSummary(scope: LedgerScope): Promise<{
  items: RecurringView[];
  active: RecurringView[];
  monthlyTotalMinor: number;
  formattedMonthlyTotal: string;
  dueSoon: RecurringView[];
  priceChanges: RecurringView[];
  stale: RecurringView[];
}> {
  const items = await listRecurring(scope);
  const active = items.filter((item) => item.status === 'active');

  const monthlyTotalMinor = active.reduce((sum, item) => sum + item.monthlyEquivalentMinor, 0);

  // A charge is late before it is missing. One cadence past due is a bank
  // holiday; two is a subscription that has actually stopped.
  const graceDays = (item: RecurringView) => Math.ceil(cadenceDays(item.cadence) * 0.5);

  return {
    items,
    active,
    monthlyTotalMinor,
    formattedMonthlyTotal: formatMoney(monthlyTotalMinor, scope.currency),
    dueSoon: active.filter((item) => item.overdueDays >= -7 && item.overdueDays <= 0),
    priceChanges: active.filter((item) => item.priceChange !== null),
    stale: active.filter((item) => item.overdueDays > graceDays(item)),
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

export async function setRecurringStatus(
  userId: string,
  id: string,
  status: RecurringStatus,
): Promise<boolean> {
  const { count } = await prisma.recurring.updateMany({ where: { id, userId }, data: { status } });
  return count > 0;
}

export async function forgetRecurring(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.recurring.deleteMany({ where: { id, userId } });
  return count > 0;
}
