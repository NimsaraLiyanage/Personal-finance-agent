'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

import type { CategoryOption } from '@/lib/finance/categories';

// Finding one entry again.
//
// Like the period and the account filter, the query lives in the URL — a search
// you are looking at should survive a reload and be a link you can send. It also
// means the server does the filtering: matching in the browser could only ever
// search the 25 rows already on screen, which is not searching.
//
// `replace` rather than `push`: typing six characters should not put six entries
// in the back stack between you and the dashboard.

export const KIND_OPTIONS = [
  { value: null, label: 'All' },
  { value: 'expense', label: 'Out' },
  { value: 'income', label: 'In' },
] as const;

export default function TransactionSearch({ categories }: { categories: CategoryOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const query = params.get('q') ?? '';
  const category = params.get('cat') ?? '';
  const kind = params.get('kind');
  const active = Boolean(query || category || kind);

  const [text, setText] = useState(query);

  // The URL is the source of truth, so anything that changes it elsewhere —
  // Clear, the back button — has to be reflected back into the field.
  useEffect(() => setText(query), [query]);

  const apply = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    startTransition(() => router.replace(`${pathname}?${next}`, { scroll: false }));
  };

  // Debounced: a keystroke is not a decision, and a round trip per letter would
  // make the list flicker through three wrong answers on the way to the right one.
  useEffect(() => {
    const typed = text.trim();
    if (typed === query) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (typed) next.set('q', typed);
      else next.delete('q');
      startTransition(() => router.replace(`${pathname}?${next}`, { scroll: false }));
    }, 300);
    return () => clearTimeout(timer);
  }, [text, query, params, pathname, router]);

  return (
    <div className={`space-y-2 transition-opacity ${pending ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <SearchGlyph />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search merchant, note or category…"
            aria-label="Search transactions"
            className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-2.5 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-accent-dim"
          />
        </div>

        <select
          value={category}
          onChange={(e) => apply({ cat: e.target.value || null })}
          aria-label="Filter by category"
          className="max-w-[9rem] rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink-dim outline-none transition-colors focus:border-accent-dim"
        >
          <option value="">All categories</option>
          {categories.map((option) => (
            <option key={option.slug} value={option.slug}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1.5">
        <div
          role="radiogroup"
          aria-label="Direction"
          className="flex gap-0.5 rounded-full border border-line bg-surface-2 p-0.5 text-[11px]"
        >
          {KIND_OPTIONS.map((option) => {
            const selected = (kind ?? null) === option.value;
            return (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => apply({ kind: option.value })}
                className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
                  selected ? 'bg-surface text-ink shadow-raised' : 'text-ink-faint hover:text-ink-dim'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {active && (
          <button
            type="button"
            onClick={() => apply({ q: null, cat: null, kind: null })}
            className="rounded-full px-2 py-1 text-[11px] font-medium text-ink-faint transition-colors hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}
