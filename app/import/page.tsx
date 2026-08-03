// Import from bank SMS.
//
// The fastest honest way to fill a ledger in Sri Lanka: the bank already sends
// a message for every card swipe, transfer and standing order. Paste them here
// and the month is done in one go, instead of remembering to log each one.
//
// The parsing lives in lib/import/sms.ts on purpose — it is a pure function
// shared by this page, the server action that writes, and eventually the
// Android build that reads the same messages off the phone directly.

import { CONTAINER } from '@/components/ui/container';
import SmsImport from '@/components/import/SmsImport';
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

  return (
    <main className="scroll-quiet h-full overflow-y-auto">
      <div className={`${CONTAINER} space-y-4 py-5 sm:py-6`}>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Import</h1>
          <p className="text-xs text-ink-faint">
            Your bank already wrote down what you spent. Paste the messages and keep them.
          </p>
        </div>

        <SmsImport
          currency={currency}
          today={formatDateInZone(new Date(), timezone)}
          categories={categories}
        />
      </div>
    </main>
  );
}
