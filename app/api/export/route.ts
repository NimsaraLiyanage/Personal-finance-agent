// GET /api/export — the ledger as a CSV file.
//
// A route handler rather than a Server Action because this is a download: the
// browser needs a real response with `Content-Disposition`, and a link is
// something you can bookmark, curl, or hand to a script.
//
// Deliberately exports EVERYTHING the row knows, including transfers marked as
// such. An export that quietly omits rows is worse than no export — the whole
// point is that the person can leave with their data and reconcile it against
// something else.

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { toCsv } from '@/lib/export/csv';
import { formatDateInZone } from '@/lib/agent/time';
import { resolveMonth } from '@/lib/finance/months';
import { toMajor } from '@/lib/money';
import { readUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Enough for years of a normal ledger; a guard, not a limit anyone will hit. */
const MAX_ROWS = 50_000;

export async function GET(request: NextRequest) {
  const user = await readUser();
  if (!user) {
    return NextResponse.json({ error: 'Nothing to export yet.' }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const monthKey = params.get('month');
  const accountId = params.get('account');

  // A month when asked for one, the whole ledger otherwise.
  let from: Date | undefined;
  let to: Date | undefined;
  let label = 'all';
  if (monthKey) {
    const month = resolveMonth(monthKey, new Date(), user.timezone);
    from = month.from;
    to = month.to;
    label = month.key;
  }

  // Scoped to the caller: an account id from the query string that isn't theirs
  // matches nothing rather than exporting a stranger's rows.
  const rows = await prisma.transaction.findMany({
    where: {
      userId: user.userId,
      ...(from && to ? { occurredAt: { gte: from, lt: to } } : {}),
      ...(accountId ? { accountId, account: { userId: user.userId } } : {}),
    },
    orderBy: { occurredAt: 'asc' },
    take: MAX_ROWS,
    include: { account: { select: { name: true } } },
  });

  const body = toCsv(
    ['Date', 'Description', 'Category', 'Account', 'Income', 'Expense', 'Currency', 'Transfer', 'Source', 'Note'],
    rows.map((row) => {
      const major = toMajor(row.amountMinor, row.currency).toFixed(2);
      const income = row.kind === 'income';
      return [
        formatDateInZone(row.occurredAt, user.timezone),
        row.merchant ?? '',
        row.category,
        row.account?.name ?? '',
        income ? major : '',
        income ? '' : major,
        row.currency,
        row.transferGroupId ? 'yes' : '',
        row.source,
        row.note ?? '',
      ];
    }),
  );

  const filename = `tally-${label}${accountId ? '-account' : ''}.csv`;

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // A ledger export must never be cached by anything in between.
      'Cache-Control': 'no-store, private',
    },
  });
}
