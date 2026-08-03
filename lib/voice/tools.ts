// Bridging the agent's tools into the Realtime API's tool format.
//
// The realtime model runs on OpenAI's side, so when it decides to call
// `log_transaction` it can't reach our database — it emits a function-call
// event to the client, which relays it here. Same tool implementations, same
// runtime, same PendingClientActions: only the transport differs.
//
// Two facts make this safe rather than a hole:
//   - the client sends only the tool NAME and ARGUMENTS; the userId comes from
//     the session cookie on our side, never from the model
//   - an unknown tool name is rejected rather than reflected

import { z } from 'zod';

import { buildTools } from '../agent/tools';
import type { PendingClientAction, ToolRuntime } from '../agent/types';

/** Realtime's tool manifest entry — flat, unlike Chat Completions' nesting. */
export interface RealtimeToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Build the manifest the Realtime session advertises.
 *
 * Schemas are converted with Zod's own JSON Schema emitter. `io: 'input'`
 * matters: it emits the shape the model must PRODUCE, so fields with defaults
 * stay optional rather than being marked required.
 */
export function buildRealtimeToolManifest(runtime: ToolRuntime): RealtimeToolDef[] {
  return buildTools(runtime).map((t) => {
    const schema = t.schema as unknown;
    let parameters: Record<string, unknown> = { type: 'object', properties: {} };
    try {
      if (schema instanceof z.ZodType) {
        parameters = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }) as Record<
          string,
          unknown
        >;
      }
    } catch {
      // A tool whose schema can't be serialised is still worth advertising
      // with an empty parameter object rather than dropping it silently.
    }
    return {
      type: 'function' as const,
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      parameters,
    };
  });
}

export interface VoiceToolResult {
  /** Short text handed back to the model as the function-call output. */
  output: string;
  /** Directives for the client UI, same union the text surface uses. */
  actions: PendingClientAction[];
}

/** Execute one tool call relayed from the realtime model. */
export async function executeVoiceTool(
  runtime: ToolRuntime,
  toolName: string,
  args: unknown,
): Promise<VoiceToolResult> {
  const tools = buildTools(runtime);
  const target = tools.find((t) => t.name === toolName);

  if (!target) {
    return { output: `Unknown tool: ${toolName}`, actions: [] };
  }

  const before = runtime.actions.length;
  try {
    // Each tool has its own argument type, so the array's `invoke` is a union
    // of incompatible signatures. Arguments arrive from the model as unknown
    // JSON regardless — the Zod schema inside the tool is what actually
    // validates them, so narrowing the call site buys nothing.
    const invoke = (target as { invoke: (input: unknown) => Promise<unknown> }).invoke.bind(target);
    const raw = await invoke(args);
    const output = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return { output, actions: runtime.actions.slice(before) };
  } catch (err) {
    // Never throw back at the model — a rejected promise here would strand the
    // realtime session waiting on a function output that never arrives.
    return {
      output: `That failed: ${(err as Error).message}`,
      actions: runtime.actions.slice(before),
    };
  }
}
