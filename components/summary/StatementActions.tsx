'use client';

// Taking the statement off the screen.
//
// Two ways out, side by side, because they answer different questions. The CSV
// is for a spreadsheet — it goes through the same `/api/export` route the whole
// ledger uses, scoped to the month and account on screen. Printing is for the
// people who still reconcile on paper, or who need a PDF to send to someone who
// will not install anything.
//
// `window.print()` rather than a print stylesheet link: the browser's own
// dialog is the one people know, and it already offers "Save as PDF".

export default function StatementActions({
  monthKey,
  accountId,
}: {
  monthKey: string;
  accountId: string | null;
}) {
  const exportHref = `/api/export?month=${encodeURIComponent(monthKey)}${
    accountId ? `&account=${encodeURIComponent(accountId)}` : ''
  }`;

  return (
    <div className="no-print flex items-center gap-1.5">
      <a
        href={exportHref}
        className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:border-accent-dim hover:text-ink"
      >
        Export CSV
      </a>
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:border-accent-dim hover:text-ink"
      >
        Print
      </button>
    </div>
  );
}
