'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import ActionCard from './ActionCard';
import VoiceControl from './VoiceControl';
import type { PendingClientAction, StreamEvent } from '@/lib/agent/types';
import type { VoiceMode } from '@/lib/voice/types';

// A rendered turn. Cards live on the message that produced them so the
// transcript stays coherent when you scroll back — the alternative, a separate
// card rail, loses the link between "you asked" and "this is the answer".
interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  actions: PendingClientAction[];
  pendingTool?: string | null;
}

const SUGGESTIONS = [
  'Coffee 4.50 and lunch 12.80',
  'How much did I spend this month?',
  'Keep dining under 200 a month',
  'Show me the last 6 months',
];

export default function Chat({ defaultVoiceMode }: { defaultVoiceMode: VoiceMode }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadId = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timezone = useRef('UTC');

  useEffect(() => {
    timezone.current = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }, []);

  // Pin to the bottom as content streams in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  /**
   * Run one turn against the SSE endpoint.
   *
   * Returns the assistant's final text so the pipeline voice controller can
   * speak it — the same call serves typing and talking.
   */
  const runTurn = useCallback(async (message: string): Promise<string> => {
    setBusy(true);
    setError(null);

    const userTurn: Turn = { id: crypto.randomUUID(), role: 'user', text: message, actions: [] };
    const assistantId = crypto.randomUUID();
    setTurns((prev) => [
      ...prev,
      userTurn,
      { id: assistantId, role: 'assistant', text: '', actions: [] },
    ]);

    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((prev) => prev.map((t) => (t.id === assistantId ? fn(t) : t)));

    let finalText = '';

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          threadId: threadId.current,
          timezone: timezone.current,
          clientNow: new Date().toISOString(),
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // SSE frames are separated by a blank line and may be split across
      // network chunks, so parse on the boundary rather than per chunk.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (!frame.startsWith('data: ')) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(frame.slice(6));
          } catch {
            continue;
          }

          switch (event.type) {
            case 'thread':
              threadId.current = event.threadId;
              break;
            case 'token':
              patch((t) => ({ ...t, text: t.text + event.delta, pendingTool: null }));
              break;
            case 'tool_start':
              patch((t) => ({ ...t, pendingTool: event.toolName }));
              break;
            case 'action':
              patch((t) => ({ ...t, actions: [...t.actions, event.action], pendingTool: null }));
              break;
            case 'done':
              finalText = event.assistantText || finalText;
              patch((t) => ({ ...t, text: event.assistantText || t.text, pendingTool: null }));
              break;
            case 'error':
              setError(event.message);
              break;
          }
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }

    return finalText;
  }, []);

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setInput('');
      await runTurn(trimmed);
    },
    [busy, runTurn],
  );

  // Voice transcripts join the same transcript list. Realtime mode produces
  // both sides itself; pipeline mode only reports the user side, because its
  // assistant text already arrived through runTurn.
  const addVoiceTranscript = useCallback((text: string, role: 'user' | 'assistant') => {
    setTurns((prev) => [...prev, { id: crypto.randomUUID(), role, text, actions: [] }]);
  }, []);

  const addVoiceAction = useCallback((action: PendingClientAction) => {
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant') {
        return prev.map((t, i) => (i === prev.length - 1 ? { ...t, actions: [...t.actions, action] } : t));
      }
      return [...prev, { id: crypto.randomUUID(), role: 'assistant', text: '', actions: [action] }];
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between py-4">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Ledger</h1>
          <p className="text-xs text-ink-faint">Tell it what you spent.</p>
        </div>
        <VoiceControl
          defaultMode={defaultVoiceMode}
          threadId={threadId}
          timezone={timezone}
          onTranscript={addVoiceTranscript}
          onAction={addVoiceAction}
          runTextTurn={runTurn}
        />
      </header>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto pb-4">
        {turns.length === 0 && (
          <div className="mt-16 text-center">
            <p className="text-sm text-ink-dim">
              Log spending in plain language, or ask about your own numbers.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void submit(s)}
                  className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-dim transition-colors hover:border-accent-dim hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn) => (
          <div key={turn.id} className="space-y-2">
            {turn.text && (
              <div className={turn.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={
                    turn.role === 'user'
                      ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-surface-2 px-3.5 py-2 text-sm'
                      : 'max-w-[90%] text-sm leading-relaxed text-ink'
                  }
                >
                  {turn.text}
                </div>
              </div>
            )}

            {turn.pendingTool && (
              <div className="flex items-center gap-2 text-xs text-ink-faint">
                <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                {humanizeTool(turn.pendingTool)}
              </div>
            )}

            {turn.actions.map((action, i) => (
              <ActionCard key={`${turn.id}-${i}`} action={action} />
            ))}
          </div>
        ))}

        {error && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(input);
        }}
        className="sticky bottom-0 flex gap-2 bg-canvas pb-5 pt-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Coffee 4.50…"
          aria-label="Message"
          className="flex-1 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-ink-faint focus:border-accent-dim"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-xl bg-accent px-4 text-sm font-medium text-canvas transition-opacity disabled:opacity-30"
        >
          {busy ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function humanizeTool(name: string): string {
  const labels: Record<string, string> = {
    log_transaction: 'Saving that…',
    get_spending_summary: 'Adding it up…',
    list_transactions: 'Looking through your transactions…',
    set_budget: 'Setting the budget…',
    get_budget_status: 'Checking your budgets…',
    get_spending_trend: 'Building the chart…',
    delete_transaction: 'Removing it…',
    schedule_reminder: 'Setting a reminder…',
    navigate_to: 'Opening…',
  };
  return labels[name] ?? 'Working…';
}
