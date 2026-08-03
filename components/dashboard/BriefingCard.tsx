'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

import { dismissBriefing, refreshBriefing } from '@/app/actions/insights';
import type { BriefingResult } from '@/lib/insights/briefing';

// The agent talking first.
//
// It leads the dashboard because it is the only thing on the page that has
// already done the reading for you — the tiles and charts below are raw
// material, this is the conclusion.

export default function BriefingCard({
  briefing,
  timezone,
}: {
  briefing: BriefingResult | null;
  timezone: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [quiet, setQuiet] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = () => {
    setError(null);
    setQuiet(false);
    startTransition(async () => {
      const result = await refreshBriefing();
      if (!result.ok) setError(result.error ?? 'Could not write the briefing.');
      else if (result.quiet) setQuiet(true);
    });
  };

  if (!briefing) {
    return (
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-faint">
              Weekly briefing
            </h2>
            <p className="mt-1 text-sm text-ink-dim">
              {quiet
                ? 'Nothing worth writing about this week — log a few things and check back.'
                : 'Once a week the assistant reads your ledger and tells you what changed.'}
            </p>
          </div>
          <button
            type="button"
            onClick={run}
            disabled={pending}
            className="shrink-0 rounded-xl border border-line bg-surface px-3.5 py-2 text-xs font-medium text-ink-dim transition-colors hover:border-accent-dim hover:text-ink disabled:opacity-50"
          >
            {pending ? 'Writing…' : 'Write it now'}
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-2 rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
            {error}
          </p>
        )}
      </section>
    );
  }

  const range = formatRange(briefing.periodStart, briefing.periodEnd, timezone);

  return (
    <section className="rounded-2xl border border-accent/25 bg-accent-soft/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-accent">
          Weekly briefing
        </h2>
        <span className="text-[11px] text-ink-faint">{range}</span>
      </div>

      <h3 className="mt-2 text-lg font-semibold leading-snug tracking-tight sm:text-xl">
        {briefing.headline}
      </h3>

      <div className="mt-2.5 space-y-2.5 text-sm leading-relaxed text-ink-dim">
        {briefing.body
          .split(/\n{2,}/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)
          .map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link
          href={`/chat?ask=${encodeURIComponent(`About this week's briefing — ${briefing.headline}. Walk me through it.`)}`}
          className="rounded-xl bg-accent px-3.5 py-2 text-xs font-medium text-white transition-all hover:brightness-110"
        >
          Ask about this
        </Link>
        <button
          type="button"
          onClick={() => startTransition(async () => void (await dismissBriefing(briefing.id)))}
          disabled={pending}
          className="rounded-xl px-3 py-2 text-xs font-medium text-ink-faint transition-colors hover:text-ink disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}

function formatRange(startIso: string, endIso: string, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone });
  return `${fmt.format(new Date(startIso))} – ${fmt.format(new Date(endIso))}`;
}
