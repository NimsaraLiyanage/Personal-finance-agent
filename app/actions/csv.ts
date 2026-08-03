'use server';

// Bank statement CSV — the write side.
//
// Same contract as the SMS importer: the browser parsed the file to draw the
// review table, but the server re-parses the identical text with the identical
// pure function before writing a single row. The client chooses the column
// mapping and can retitle a category; it cannot decide what a number is.
//
// A statement belongs to ONE account, so the account is picked once for the
// upload rather than per row — and the masked card number is usually in the
// filename or the header, not the data.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { defaultAccountId, resolveAccount } from '@/lib/finance/accounts';
import { resolveCategory } from '@/lib/finance/categories';
import { refreshRecurring } from '@/lib/finance/recurring';
import { formatDateInZone, parseOccurredAt } from '@/lib/agent/time';
import { applyMapping, parseCsv, validateMapping, type ColumnRole } from '@/lib/import/csv';
import { resolveUser } from '@/lib/session';

/** A statement of any realistic length fits well inside this. */
const MAX_TEXT = 2_000_000;

const ROLES = [
  'date',
  'description',
  'amount',
  'debit',
  'credit',
  'balance',
  'category',
  'reference',
  'ignore',
] as const;

const InputSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT),
  delimiter: z.string().min(1).max(1).optional(),
  roles: z.array(z.enum(ROLES)).min(1).max(64),
  /** Fingerprints of the rows ticked in review. */
  selected: z.array(z.string().regex(/^[0-9a-f]{16}$/)).min(1).max(2000),
  /** Per-row category overrides, keyed by fingerprint. */
  categories: z.record(z.string(), z.string().trim().min(1).max(40)).optional(),
  accountId: z.string().trim().optional(),
});

export interface CsvImportOutcome {
  ok: boolean;
  imported: number;
  duplicates: number;
  skipped: number;
  error?: string;
}

export async function importCsv(input: z.input<typeof InputSchema>): Promise<CsvImportOutcome> {
  const parsedInput = InputSchema.safeParse(input);
  if (!parsedInput.success) {
    return { ok: false, imported: 0, duplicates: 0, skipped: 0, error: 'Nothing to import.' };
  }

  const mappingError = validateMapping({ roles: parsedInput.data.roles as ColumnRole[] });
  if (mappingError) {
    return { ok: false, imported: 0, duplicates: 0, skipped: 0, error: mappingError };
  }

  const { userId, currency, timezone } = await resolveUser();
  const now = new Date();
  const today = formatDateInZone(now, timezone);

  // Re-parse server-side. This is the authority; the preview was a preview.
  const table = parseCsv(parsedInput.data.text, parsedInput.data.delimiter);
  const report = applyMapping(table, { roles: parsedInput.data.roles as ColumnRole[] }, {
    currency,
    today,
  });

  const wanted = new Set(parsedInput.data.selected);
  const overrides = parsedInput.data.categories ?? {};

  const accountId =
    (await resolveAccount(userId, parsedInput.data.accountId)) ??
    (await defaultAccountId(userId, currency));

  // Two identical lines in one file are two real transactions — a person can
  // buy the same coffee twice in a day. Only a repeat across uploads is a
  // duplicate, so the in-file counter gives the second copy its own key.
  const seen = new Map<string, number>();
  const rows: Array<Record<string, unknown>> = [];

  for (const row of report.rows) {
    if (!wanted.has(row.fingerprint)) continue;

    const count = (seen.get(row.fingerprint) ?? 0) + 1;
    seen.set(row.fingerprint, count);
    const importKey = count === 1 ? `csv:${row.fingerprint}` : `csv:${row.fingerprint}#${count}`;

    const category = await resolveCategory(
      userId,
      overrides[row.fingerprint] ?? row.category ?? 'other',
      { merchant: row.description },
    );

    rows.push({
      userId,
      kind: row.kind,
      amountMinor: row.amountMinor,
      currency,
      merchant: row.description,
      category,
      // The line as the bank wrote it. When a figure looks wrong in six
      // months, that is the only useful record of where it came from.
      note: row.raw.slice(0, 200),
      occurredAt: parseOccurredAt(row.occurredOn ?? today, now, timezone),
      source: 'csv',
      importKey,
      accountId,
    });
  }

  if (rows.length === 0) {
    return { ok: true, imported: 0, duplicates: 0, skipped: report.rejected.length };
  }

  const existing = await prisma.transaction.findMany({
    where: { userId, importKey: { in: rows.map((r) => r.importKey as string) } },
    select: { importKey: true },
  });
  const known = new Set(existing.map((row) => row.importKey));
  const fresh = rows.filter((row) => !known.has(row.importKey as string));

  const { count } = await prisma.transaction.createMany({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: fresh as any,
    skipDuplicates: true,
  });

  if (count > 0) {
    // A statement is months of history arriving at once — the moment a
    // subscription becomes visible. Best-effort: a failed scan must not fail an
    // import that has already written its rows.
    await refreshRecurring({ userId, currency, timezone, now }).catch((err) =>
      console.error('[csv] recurring scan failed:', err),
    );
  }

  revalidatePath('/');
  revalidatePath('/summary');

  return {
    ok: true,
    imported: count,
    duplicates: rows.length - count,
    skipped: report.rejected.length,
  };
}

/** Which of these statement rows are already in the ledger. */
export async function findImportedCsvRows(fingerprints: string[]): Promise<string[]> {
  const wanted = fingerprints.filter((f) => /^[0-9a-f]{16}$/.test(f)).slice(0, 2000);
  if (wanted.length === 0) return [];

  const { userId } = await resolveUser();
  const rows = await prisma.transaction.findMany({
    where: { userId, importKey: { in: wanted.map((f) => `csv:${f}`) } },
    select: { importKey: true },
  });
  return rows.map((row) => row.importKey!.slice(4));
}
