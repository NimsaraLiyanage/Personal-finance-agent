// Import from bank SMS.
//
// The fastest honest way to fill a ledger in Sri Lanka: the bank already sends
// a message for every card swipe, transfer and standing order. Paste them here
// and the month is done in one go, instead of remembering to log each one.
//
// The parsing lives in lib/import/sms.ts on purpose — it is a pure function
// shared by this page, the server action that writes, and eventually the
// Android build that reads the same messages off the phone directly.

import Link from 'next/link';

import { CONTAINER } from '@/components/ui/container';
import ImportTabs from '@/components/import/ImportTabs';
import { listAccounts } from '@/lib/finance/accounts';
import { DEFAULT_CATEGORY_OPTIONS, listCategories } from '@/lib/finance/categories';
import { formatDateInZone } from '@/lib/agent/time';
import { readUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const user = await readUser();

  const timezone = user?.timezone ?? process.env.DEFAULT_TIMEZONE?.trim() ?? 'UTC';
  const currency = user?.currency ?? process.env.DEFAULT_CURRENCY?.trim().toUpperCase() ?? 'USD';
  // A first-time visitor has no user row yet (a Server Component cannot mint
  // one), so they get the default list — the import action creates the row.
  const categories = user ? await listCategories(user.userId) : DEFAULT_CATEGORY_OPTIONS;
  const accounts = user ? await listAccounts(user.userId, user.currency) : [];

  return (
    <main className="scroll-quiet h-full overflow-y-auto">
      <div className={`${CONTAINER} space-y-4 py-5 sm:py-6`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Import</h1>
            <p className="text-xs text-ink-faint">
              Your bank already wrote down what you spent. Bring it across and keep it.
            </p>
          </div>

          {/* The way out, next to the way in. A ledger you cannot leave with is
              not really yours, and putting the export anywhere else would be a
              small dishonesty about that. */}
          {user && (
            <a
              href="/api/export"
              className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:border-accent-dim hover:text-ink"
            >
              Export everything as CSV
            </a>
          )}
        </div>

        <ImportTabs
          currency={currency}
          today={formatDateInZone(new Date(), timezone)}
          categories={categories}
          accounts={accounts}
        />

        {!user && (
          <p className="text-xs text-ink-faint">
            Nothing imported yet, so there is nothing to export.{' '}
            <Link href="/" className="text-accent hover:underline">
              Start on the dashboard
            </Link>
            .
          </p>
        )}
      </div>
    </main>
  );
}
