'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { authClient } from '@/lib/auth/client';

// Who you are, in the corner of the nav.
//
// Anonymous is a real state here, not a logged-out one: the ledger works, it
// just lives in this browser. So the prompt is honest about the risk ("only on
// this device") rather than nagging, and it never blocks anything.

export default function AccountMenu() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // Reserve the space rather than popping a "Sign in" button in a beat later.
  if (isPending) return <span className="h-7 w-16" aria-hidden />;

  const user = session?.user as
    | { email?: string | null; name?: string | null; isAnonymous?: boolean | null }
    | undefined;
  const email = user?.email ?? null;
  const name = user?.name ?? null;
  const isAnonymous = Boolean(user?.isAnonymous) || (email?.endsWith('@anonymous.local') ?? false);

  if (!email || isAnonymous) {
    return (
      <Link
        href="/sign-in"
        className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:border-accent-dim hover:text-ink"
        title="Your ledger currently lives only in this browser"
      >
        Sign in
      </Link>
    );
  }

  const label = name?.trim() || email;

  const signOut = () => {
    startTransition(async () => {
      await authClient.signOut();
      setOpen(false);
      router.push('/sign-in');
      router.refresh();
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1.5 text-xs font-medium text-ink-dim transition-colors hover:border-line-strong hover:text-ink"
      >
        <span className="grid size-4 place-items-center rounded-full bg-accent-soft text-[10px] font-semibold uppercase text-accent">
          {label.charAt(0)}
        </span>
        <span className="max-w-[10rem] truncate">{label}</span>
      </button>

      {open && (
        <>
          {/* Click-away, and the thing screen readers skip. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1.5 w-56 rounded-xl border border-line bg-surface p-1 shadow-card"
          >
            <p className="truncate px-2.5 py-2 text-[11px] text-ink-faint">{email}</p>
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              disabled={pending}
              className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-ink-dim transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
            >
              {pending ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
