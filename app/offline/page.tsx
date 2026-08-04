// Shown by the service worker when a page is requested with no network.
//
// It says one thing, and says it plainly: this is not your ledger. The
// alternative — serving a cached dashboard — would show real-looking figures
// from an unknown moment in the past, and someone would make a decision on
// them. A blank page that admits it is blank is the honest option.

import { TallyMark } from '@/components/SiteNav';
import { CONTAINER } from '@/components/ui/container';

export const dynamic = 'force-static';

export default function OfflinePage() {
  return (
    <main className="grid h-full place-items-center">
      <div className={`${CONTAINER} max-w-sm text-center`}>
        <TallyMark className="mx-auto size-10" />
        <h1 className="mt-3 text-lg font-semibold tracking-tight">No connection</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-dim">
          Tally needs the network to show your ledger. Nothing is cached on purpose — a balance
          from an unknown moment ago is worse than no balance at all.
        </p>
        <p className="mt-3 text-xs text-ink-faint">
          Anything you were part-way through typing is still in this tab.
        </p>
      </div>
    </main>
  );
}
