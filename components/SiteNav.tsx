'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { CONTAINER } from '@/components/ui/container';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/summary', label: 'Summary' },
  { href: '/chat', label: 'Assistant' },
] as const;

export default function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="shrink-0 border-b border-line bg-surface">
      {/* The bar's background and border span the window — it is chrome. What
          sits inside it uses the same column as the page, so the logo lands
          directly above the page heading rather than off on its own. */}
      <div className={`${CONTAINER} flex items-center gap-4 py-2.5`}>
        <Link href="/" className="flex items-center gap-2.5" aria-label="Tally home">
          <TallyMark />
          <span className="text-sm font-semibold tracking-tight">Tally</span>
        </Link>

        <nav aria-label="Main" className="ml-2 flex items-center gap-1 text-xs">
          {LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`rounded-full px-3 py-1.5 font-medium transition-colors ${
                  active
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-dim hover:bg-surface-2 hover:text-ink'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

// Three strokes and a slash — the mark you make on paper when you're counting
// something one at a time, which is exactly what the app does.
export function TallyMark({ className = 'size-8' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-xl bg-accent text-white shadow-raised ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-[62%]"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.1}
        strokeLinecap="round"
      >
        <path d="M7 6.5v11M12 6.5v11M17 6.5v11" />
        <path d="M4.8 17.6 19.2 6.4" strokeWidth={2.4} />
      </svg>
    </span>
  );
}
