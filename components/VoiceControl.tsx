'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { createVoiceController, type VoiceController, type VoiceState } from '@/lib/client/voice';
import type { VoiceMode, VoiceSession } from '@/lib/voice/types';
import type { PendingClientAction } from '@/lib/agent/types';

// The whole voice UI: a mode toggle and one button.
//
// The mode toggle exists because the two transports are worth *comparing* —
// same agent, same tools, visibly different latency and turn-taking. In a
// product you would pick one; in a portfolio the switch is the point.

interface Props {
  defaultMode: VoiceMode;
  threadId: React.RefObject<string | null>;
  timezone: React.RefObject<string>;
  onTranscript: (text: string, role: 'user' | 'assistant') => void;
  onAction: (action: PendingClientAction) => void;
  runTextTurn: (text: string) => Promise<string>;
}

// "Pipeline" and "Realtime" mean nothing to someone seeing the app for the
// first time, and the difference is a real trade-off rather than a detail — so
// the toggle carries an explanation instead of assuming the label lands.
const MODE_HELP: Record<VoiceMode, { label: string; tagline: string; blurb: string }> = {
  pipeline: {
    label: 'Pipeline',
    tagline: 'Slower, does everything',
    blurb:
      'What you say is transcribed, sent through the same agent that answers your typing, then read back aloud. A beat slower to reply — but every tool and every card works exactly as it does in text.',
  },
  realtime: {
    label: 'Realtime',
    tagline: 'Instant, conversational',
    blurb:
      'Speech goes straight to speech over one live connection. Replies come back almost immediately and you can interrupt mid-sentence, which makes it feel like a phone call.',
  },
};

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Talk',
  connecting: 'Connecting…',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  error: 'Error',
};

export default function VoiceControl({
  defaultMode,
  threadId,
  timezone,
  onTranscript,
  onAction,
  runTextTurn,
}: Props) {
  const [mode, setMode] = useState<VoiceMode>(defaultMode);
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const controller = useRef<VoiceController | null>(null);

  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setHelpOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen]);

  // A live mic and an open peer connection both outlive React's render cycle —
  // tear them down if this unmounts mid-session.
  useEffect(() => {
    return () => controller.current?.stop();
  }, []);

  const stop = useCallback(() => {
    controller.current?.stop();
    controller.current = null;
    setState('idle');
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setState('connecting');

    try {
      const response = await fetch('/api/voice/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          threadId: threadId.current,
          timezone: timezone.current,
          clientNow: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `Could not start voice (${response.status})`);
      }

      const session = (await response.json()) as VoiceSession;
      threadId.current = session.threadId;

      const instance = createVoiceController(
        session,
        {
          onState: setState,
          onTranscript,
          onAction,
          onError: (message) => {
            setError(message);
            setState('error');
          },
          // Pipeline mode routes each transcript through the ordinary text
          // turn, so voice inherits every tool and card for free.
          runTextTurn,
        },
        { timezone: timezone.current },
      );

      controller.current = instance;
      await instance.start();
    } catch (err) {
      setError((err as Error).message);
      setState('error');
      controller.current?.stop();
      controller.current = null;
    }
  }, [mode, onAction, onTranscript, runTextTurn, threadId, timezone]);

  const active = state !== 'idle' && state !== 'error';

  return (
    <div className="relative flex items-center gap-2">
      {!active && (
        <>
          <div
            role="radiogroup"
            aria-label="Voice mode"
            className="flex rounded-full border border-line bg-surface-2 p-0.5 text-[11px]"
          >
            {(['pipeline', 'realtime'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                title={`${MODE_HELP[m].label} — ${MODE_HELP[m].tagline}`}
                className={`rounded-full px-2.5 py-1 font-medium transition-colors ${
                  mode === m
                    ? 'bg-surface text-ink shadow-raised'
                    : 'text-ink-faint hover:text-ink-dim'
                }`}
              >
                {MODE_HELP[m].label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setHelpOpen((open) => !open)}
            aria-expanded={helpOpen}
            aria-label="What is the difference between the voice modes?"
            className={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold transition-colors ${
              helpOpen
                ? 'border-accent bg-accent text-white'
                : 'border-line text-ink-faint hover:border-accent-dim hover:text-ink-dim'
            }`}
          >
            ?
          </button>
        </>
      )}

      <button
        type="button"
        onClick={() => (active ? stop() : void start())}
        title={error ?? undefined}
        aria-label={active ? 'Stop voice session' : 'Start voice session'}
        className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium shadow-raised transition-colors ${
          active
            ? 'bg-accent text-white'
            : state === 'error'
              ? 'border border-danger/40 bg-danger/8 text-danger'
              : 'border border-line bg-surface text-ink-dim hover:border-accent-dim hover:text-ink'
        } ${state === 'listening' ? 'animate-pulse-ring' : ''}`}
      >
        <span aria-hidden>{active ? '■' : '🎙'}</span>
        {STATE_LABEL[state]}
      </button>

      {helpOpen && (
        <>
          {/* Click-away layer. Sits under the panel but over the page, so the
              next click anywhere dismisses instead of acting twice. */}
          <div className="fixed inset-0 z-20" onClick={() => setHelpOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-label="Voice modes"
            className="absolute right-0 top-full z-30 mt-2 w-[19.5rem] animate-rise rounded-xl border border-line bg-surface p-3.5 text-left shadow-card"
          >
            <p className="text-xs text-ink-faint">
              Two ways to run the same agent by voice — same tools, same ledger.
            </p>
            <ul className="mt-3 space-y-3">
              {(['pipeline', 'realtime'] as const).map((m) => (
                <li key={m}>
                  <button
                    type="button"
                    onClick={() => {
                      setMode(m);
                      setHelpOpen(false);
                    }}
                    className="w-full text-left"
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-ink">{MODE_HELP[m].label}</span>
                      <span className="text-[11px] text-ink-faint">{MODE_HELP[m].tagline}</span>
                      {mode === m && (
                        <span className="ml-auto rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                          on
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-ink-dim">
                      {MODE_HELP[m].blurb}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
