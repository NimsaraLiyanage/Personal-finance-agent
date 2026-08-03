// SSE streaming for a chat turn.
//
// Three things have to come out of one HTTP response, interleaved in real time:
//
//   1. prose tokens, as the model writes them
//   2. `PendingClientAction`s, the instant a tool finishes — so a card can
//      appear *before* the sentence that describes it
//   3. a terminal `done` frame carrying the final text for persistence-free
//      client state
//
// LangGraph's `custom` stream mode carries (1) via `config.writer` in the agent
// node. (2) is not a stream mode — tool executors push into `runtime.actions`
// synchronously, so after every chunk we drain whatever is new. `values` mode
// gives the full state after each node, whose last emission is the final state
// we persist from.

import type { PendingClientAction, StreamEvent, ToolRuntime } from './types';
import type { AgentLlm } from './model';
import {
  buildAgentGraph,
  extractAssistantText,
  persistTurn,
  type AgentState,
} from './graph';
import { ensureThreadTitle } from './persistence';
import { maybeSummarizeThread } from './summary';

function frame(event: StreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export interface StreamTurnArgs {
  runtime: ToolRuntime;
  userMessage: string;
  modelFactory?: () => AgentLlm;
}

export function streamTurn({ runtime, userMessage, modelFactory }: StreamTurnArgs): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: StreamEvent) => {
        if (!closed) controller.enqueue(frame(event));
      };

      // Emitted actions are tracked by index rather than by splicing the array,
      // so the route can still read the complete list afterwards.
      let emittedActions = 0;
      const drainActions = () => {
        while (emittedActions < runtime.actions.length) {
          send({ type: 'action', action: runtime.actions[emittedActions] as PendingClientAction });
          emittedActions++;
        }
      };

      try {
        send({ type: 'thread', threadId: runtime.threadId });

        const graph = await buildAgentGraph({ runtime, modelFactory });

        let finalState: AgentState | undefined;
        const seenTools = new Set<string>();

        const stream = await graph.stream(
          { threadId: runtime.threadId, userMessage, messages: [] },
          { streamMode: ['custom', 'values'] },
        );

        for await (const chunk of stream as AsyncIterable<[string, unknown]>) {
          const [mode, payload] = chunk;

          if (mode === 'custom') {
            const custom = payload as { type?: string; delta?: string };
            if (custom?.type === 'token' && custom.delta) {
              send({ type: 'token', delta: custom.delta });
            }
            continue;
          }

          if (mode === 'values') {
            const state = payload as AgentState;
            finalState = state;

            // Announce tool calls as soon as the model commits to them, so the
            // UI can show "checking your budgets…" during the round trip.
            const last = state.messages?.[state.messages.length - 1];
            const toolCalls = (last as { tool_calls?: Array<{ id?: string; name?: string }> })
              ?.tool_calls;
            if (Array.isArray(toolCalls)) {
              for (const call of toolCalls) {
                const key = call.id ?? call.name ?? '';
                if (call.name && !seenTools.has(key)) {
                  seenTools.add(key);
                  send({ type: 'tool_start', toolName: call.name });
                }
              }
            }
          }

          drainActions();
        }

        drainActions();

        const assistantText = finalState ? extractAssistantText(finalState.messages) : '';

        if (finalState) {
          await persistTurn(runtime.threadId, userMessage, finalState.messages, runtime.actions);
          await ensureThreadTitle(runtime.threadId, userMessage);
        }

        send({ type: 'done', assistantText });

        // Summarisation is fire-and-forget: it must never delay the reply the
        // user is waiting on, and a failure here is not a failed turn.
        void maybeSummarizeThread(runtime.threadId, modelFactory).catch((err) => {
          console.warn('[agent] summarisation failed:', (err as Error).message);
        });
      } catch (err) {
        const message = (err as Error).message || 'Something went wrong.';
        console.error('[agent] turn failed:', err);
        send({ type: 'error', message });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Nginx and some proxies buffer streamed responses into uselessness.
  'X-Accel-Buffering': 'no',
} as const;
