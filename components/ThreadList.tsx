'use client';

import { useCallback, useEffect, useState } from 'react';

// The conversation rail.
//
// `/api/threads` has existed since the first commit with a comment calling it
// "the conversation list for the sidebar" — there was no sidebar, so every
// thread ever written was unreachable and a page reload silently started a new
// one. This is that sidebar.

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
}

interface Props {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Bumped by the parent after a turn, so a new thread's title appears. */
  refreshToken: number;
}

export default function ThreadList({ activeId, onSelect, onNew, refreshToken }: Props) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/threads');
      if (!response.ok) return;
      const data = (await response.json()) as { threads: ThreadSummary[] };
      setThreads(data.threads);
    } catch {
      // A failed list is not worth an error state — the composer still works.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await fetch(`/api/threads/${id}`, { method: 'DELETE' });
      setThreads((prev) => prev.filter((t) => t.id !== id));
      if (id === activeId) onNew();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <button
        type="button"
        onClick={onNew}
        className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-dim transition-colors hover:border-accent-dim hover:text-ink"
      >
        <span aria-hidden>+</span> New conversation
      </button>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-1 py-2 text-xs text-ink-faint">Loading…</p>
        ) : threads.length === 0 ? (
          <p className="px-1 py-2 text-xs leading-relaxed text-ink-faint">
            Past conversations show up here once you&rsquo;ve had one.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {threads.map((thread) => {
              const active = thread.id === activeId;
              return (
                <li key={thread.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(thread.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`w-full rounded-lg py-2 pl-2.5 pr-7 text-left transition-colors ${
                      active ? 'bg-accent-soft' : 'hover:bg-surface-2'
                    } ${busyId === thread.id ? 'opacity-40' : ''}`}
                  >
                    <span
                      className={`block truncate text-xs ${active ? 'font-medium text-accent' : 'text-ink-dim'}`}
                    >
                      {thread.title}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-ink-faint">
                      {relativeDay(thread.updatedAt)}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void remove(thread.id)}
                    disabled={busyId === thread.id}
                    aria-label={`Delete conversation "${thread.title}"`}
                    className="absolute right-1 top-2 rounded px-1 text-xs text-ink-faint opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function relativeDay(iso: string): string {
  const then = new Date(iso);
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(then);
}
