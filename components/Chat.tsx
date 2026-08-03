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
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-canvas/85 py-3.5 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-white shadow-raised"
          >
            L
          </span>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Ledger</h1>
            <p className="text-xs text-ink-faint">Tell it what you spent.</p>
          </div>
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

      <div ref={scrollRef} className="scroll-quiet flex-1 space-y-4 overflow-y-auto py-6">
        {turns.length === 0 && (
          <div className="mt-12 text-center sm:mt-20">
            <h2 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
              What did you spend today?
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-dim">
              Log spending in plain language, or ask about your own numbers.
            </p>
            <div className="mx-auto mt-6 flex max-w-lg flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void submit(s)}
                  className="rounded-full border border-line bg-surface px-3.5 py-2 text-xs text-ink-dim shadow-raised transition-all hover:-translate-y-px hover:border-accent-dim hover:text-ink"
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
                      ? 'max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm leading-relaxed text-white shadow-raised'
                      : 'max-w-[90%] whitespace-pre-wrap text-sm leading-relaxed text-ink'
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
          <div className="rounded-xl border border-danger/25 bg-danger/8 px-3.5 py-2.5 text-sm text-danger">
            {error}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(input);
        }}
        className="sticky bottom-0 bg-canvas pb-5"
      >
        {/* Fades the transcript out under the composer instead of letting it
            collide with the input's top edge. */}
        <div
          aria-hidden
          className="pointer-events-none -mt-6 h-6 bg-gradient-to-b from-transparent to-canvas"
        />
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-1.5 shadow-card transition-colors focus-within:border-accent-dim">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Coffee 4.50…"
            aria-label="Message"
            className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus-visible:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:bg-line-strong disabled:text-ink-faint"
          >
            {busy ? '…' : 'Send'}
          </button>
        </div>
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
