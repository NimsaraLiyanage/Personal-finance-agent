import type { CategoryTotal } from '@/lib/agent/types';
import { formatMoney } from '@/lib/money';

// Ranked bars, one hue.
//
// Category here is a *magnitude* question ("where did most of it go"), not an
// identity one — so this is a sequential single-hue chart, not thirteen colours
// nobody can tell apart. The rank order carries which is which; the label sits
// beside its own bar.

const VISIBLE = 7;

export default function CategoryBreakdown({
  categories,
  totalFormatted,
  currency,
}: {
  categories: CategoryTotal[];
  totalFormatted: string;
  currency: string;
}) {
  if (categories.length === 0) {
    return (
      <Frame>
        <p className="py-8 text-center text-sm text-ink-faint">
          No spending in this period yet.
        </p>
      </Frame>
    );
  }

  const shown = categories.slice(0, VISIBLE);
  const rest = categories.slice(VISIBLE);
  const restTotal = rest.reduce((sum, c) => sum + c.totalMinor, 0);
  const restShare = rest.reduce((sum, c) => sum + c.share, 0);
  const max = shown[0].totalMinor || 1;

  return (
    <Frame total={totalFormatted}>
      <ol className="space-y-2.5">
        {shown.map((c) => (
          <li key={c.category} className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 truncate capitalize text-ink-dim">{c.category}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-line/70">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${Math.max(2, (c.totalMinor / max) * 100)}%` }}
              />
            </span>
            <span className="w-10 shrink-0 text-right text-[11px] tnum text-ink-faint">
              {Math.round(c.share * 100)}%
            </span>
            <span className="w-20 shrink-0 text-right text-sm tnum">{c.formatted}</span>
          </li>
        ))}
      </ol>

      {rest.length > 0 && (
        <p className="mt-3 border-t border-line pt-2.5 text-xs text-ink-faint">
          <span className="tnum">{formatMoney(restTotal, currency)}</span> more across{' '}
          {rest.length} smaller {rest.length === 1 ? 'category' : 'categories'} (
          <span className="tnum">{Math.round(restShare * 100)}%</span>)
        </p>
      )}
    </Frame>
  );
}

function Frame({ total, children }: { total?: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
          Where it went
        </h2>
        {total && <span className="text-sm font-semibold tnum">{total}</span>}
      </div>
      {children}
    </section>
  );
}
