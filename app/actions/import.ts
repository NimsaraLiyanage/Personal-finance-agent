'use server';

// SMS import — the write side.
//
// The browser already parsed the paste to draw the review table, but it does
// not get to decide what lands in the ledger. This action re-runs the identical
// parser (lib/import/sms.ts is pure, so "identical" is literal) against the raw
// message text and writes from *its* result. The client can retitle a category;
// it cannot move a decimal point.
//
// Everything here is idempotent. `importKey` carries a hash of the message, and
// a unique index on (userId, importKey) means the second copy of a message is a
// collision rather than a second Rs 2,500 — which matters because the natural
// way to use this feature is to paste an overlapping range every few days.

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import {
  defaultAccountId,
  findAccountByKind,
  matchAccountByLast4,
  recordTransfer,
} from '@/lib/finance/accounts';
import { resolveCategory } from '@/lib/finance/categories';
import { formatDateInZone, parseOccurredAt } from '@/lib/agent/time';
import { parseMessage } from '@/lib/import/sms';
import { resolveUser, SESSION_COOKIE } from '@/lib/session';

async function session() {
  const resolved = await resolveUser();
  if (resolved.setCookie) {
    const jar = await cookies();
    jar.set(SESSION_COOKIE.name, resolved.setCookie, SESSION_COOKIE.options);
  }
  return resolved;
}

/**
 * Which of these messages are already in the ledger.
 *
 * Read-only and takes no user input beyond hashes, so it uses `readUser`'s
 * cheaper sibling path: a visitor with no session simply has nothing imported.
 */
export async function findAlreadyImported(fingerprints: string[]): Promise<string[]> {
  const wanted = fingerprints.filter((f) => /^[0-9a-f]{16}$/.test(f)).slice(0, 500);
  if (wanted.length === 0) return [];

  const { userId } = await session();
  const rows = await prisma.transaction.findMany({
    where: { userId, importKey: { in: wanted.map((f) => `sms:${f}`) } },
    select: { importKey: true },
  });

  return rows.map((row) => row.importKey!.slice(4));
}

const ItemSchema = z.object({
  raw: z.string().min(1).max(1200),
  /** What the person chose in the review table, if they changed it. */
  category: z.string().trim().min(1).max(40).optional(),
});

const BatchSchema = z.array(ItemSchema).min(1).max(200);

export interface ImportOutcome {
  ok: boolean;
  imported: number;
  /** Already in the ledger from an earlier paste. */
  duplicates: number;
  /** ATM withdrawals recorded as a move to cash rather than as spending. */
  transfers: number;
  /** Couldn't be turned into an entry, with the reason to show. */
  rejected: Array<{ raw: string; reason: string }>;
  error?: string;
}

export async function importMessages(
  items: Array<{ raw: string; category?: string }>,
): Promise<ImportOutcome> {
  const parsedInput = BatchSchema.safeParse(items);
  if (!parsedInput.success) {
    return {
      ok: false,
      imported: 0,
      duplicates: 0,
      transfers: 0,
      rejected: [],
      error: 'Nothing to import.',
    };
  }

  const { userId, currency, timezone } = await session();
  const now = new Date();
  const today = formatDateInZone(now, timezone);

  // Resolved once for the batch: a paste is dozens of messages and these are
  // the same two answers every time. Sequential on purpose — the first call
  // seeds the starting Cash account, and the second has to see it.
  const fallbackAccountId = await defaultAccountId(userId, currency);
  const cashAccountId = await findAccountByKind(userId, 'cash');

  const rejected: ImportOutcome['rejected'] = [];
  let transfers = 0;
  let transferDuplicates = 0;
  const rows: Array<{
    userId: string;
    kind: 'expense' | 'income';
    amountMinor: number;
    currency: string;
    merchant: string | null;
    category: string;
    note: string;
    occurredAt: Date;
    source: string;
    importKey: string;
    accountId: string | null;
  }> = [];

  // Two identical messages in ONE paste are two real transactions — a person
  // can buy the same tea twice. Only a repeat across pastes is a duplicate, so
  // the in-batch counter gives the second copy its own key.
  const seenInBatch = new Map<string, number>();

  for (const item of parsedInput.data) {
    const parsed = parseMessage(item.raw, { currency, today });

    if ('reason' in parsed) {
      rejected.push({ raw: item.raw, reason: parsed.reason });
      continue;
    }

    if (parsed.currency !== currency) {
      rejected.push({
        raw: item.raw,
        reason: `This one is in ${parsed.currency}. Your ledger is in ${currency} and there is no exchange rate here — add it by hand at the rate you actually got.`,
      });
      continue;
    }

    // A remembered correction beats the parser's guess; the person's own pick
    // in the review table beats nothing, because it IS the person.
    const category = await resolveCategory(userId, item.category ?? parsed.category, {
      merchant: parsed.merchant,
    });

    const count = (seenInBatch.get(parsed.fingerprint) ?? 0) + 1;
    seenInBatch.set(parsed.fingerprint, count);
    const importKey = count === 1 ? `sms:${parsed.fingerprint}` : `sms:${parsed.fingerprint}#${count}`;

    // The card the bank masked, if it belongs to an account they set up.
    const matchedAccountId = await matchAccountByLast4(userId, parsed.accountTail);
    const accountId = matchedAccountId ?? fallbackAccountId;

    // An ATM withdrawal moved money between two of their own pockets. Recorded
    // as a transfer when both ends are known, so the month is not overstated
    // once at the machine and again when the cash gets spent.
    if (parsed.cashWithdrawal && cashAccountId && accountId && accountId !== cashAccountId) {
      const moved = await recordTransfer(
        { userId, currency },
        {
          fromAccountId: accountId,
          toAccountId: cashAccountId,
          amountMinor: parsed.amountMinor,
          occurredAt: parseOccurredAt(parsed.occurredOn ?? today, now, timezone),
          note: parsed.raw.slice(0, 200),
          source: 'sms',
          importKey,
        },
      );
      if (moved.ok) {
        transfers++;
        continue;
      }
      if (moved.duplicate) {
        transferDuplicates++;
        continue;
      }
      // Anything else falls through to an ordinary expense — a recorded expense
      // beats a silently dropped withdrawal.
    }

    rows.push({
      userId,
      kind: parsed.kind,
      amountMinor: parsed.amountMinor,
      currency,
      merchant: parsed.merchant,
      category,
      // Keep the message. When a figure looks wrong in six months, the only
      // useful answer is the sentence the bank actually sent.
      note: parsed.raw.slice(0, 200),
      occurredAt: parseOccurredAt(parsed.occurredOn ?? today, now, timezone),
      source: 'sms',
      importKey,
      accountId,
    });
  }

  if (rows.length === 0) {
    if (transfers > 0) {
      revalidatePath('/');
      revalidatePath('/summary');
    }
    return {
      ok: rejected.length === 0,
      imported: transfers,
      duplicates: transferDuplicates,
      transfers,
      rejected,
    };
  }

  const existing = await prisma.transaction.findMany({
    where: { userId, importKey: { in: rows.map((r) => r.importKey) } },
    select: { importKey: true },
  });
  const known = new Set(existing.map((row) => row.importKey));
  const fresh = rows.filter((row) => !known.has(row.importKey));

  // `skipDuplicates` on top of the pre-filter: the check above is a nicety for
  // the count we report, the unique index is what actually guarantees it.
  const { count } = await prisma.transaction.createMany({ data: fresh, skipDuplicates: true });

  revalidatePath('/');
  revalidatePath('/summary');
  revalidatePath('/chat');

  return {
    ok: true,
    imported: count + transfers,
    duplicates: rows.length - count + transferDuplicates,
    transfers,
    rejected,
  };
}
