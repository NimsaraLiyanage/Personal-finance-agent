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
  const controller = useRef<VoiceController | null>(null);

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
    <div className="flex items-center gap-2">
      {!active && (
        <div
          role="radiogroup"
          aria-label="Voice mode"
          className="flex rounded-full border border-line p-0.5 text-[11px]"
        >
          {(['pipeline', 'realtime'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-full px-2.5 py-1 transition-colors ${
                mode === m ? 'bg-surface-2 text-ink' : 'text-ink-faint hover:text-ink-dim'
              }`}
            >
              {m === 'pipeline' ? 'Pipeline' : 'Realtime'}
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => (active ? stop() : void start())}
        title={error ?? undefined}
        aria-label={active ? 'Stop voice session' : 'Start voice session'}
        className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
          active
            ? 'bg-accent text-canvas'
            : state === 'error'
              ? 'border border-danger/50 text-danger'
              : 'border border-line text-ink-dim hover:border-accent-dim hover:text-ink'
        } ${state === 'listening' ? 'animate-pulse-ring' : ''}`}
      >
        <span aria-hidden>{active ? '■' : '🎙'}</span>
        {STATE_LABEL[state]}
      </button>
    </div>
  );
}
