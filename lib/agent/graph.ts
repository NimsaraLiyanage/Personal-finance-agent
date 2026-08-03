// The agent graph — a ReAct loop built with LangGraph.
//
//   START → loadContext → agent ⇄ tools → END
//
// `loadContext` assembles the prompt for the turn (system + account snapshot +
// rolling summary + replayed history + the new message). `agent` calls the
// model with tools bound. `toolsCondition` routes to `tools` whenever the model
// emitted tool calls, and back to `agent` so it can react to the results —
// that cycle is what lets one user message produce several tool calls and a
// final sentence that accounts for all of them.
//
// The agent node **streams**: prose deltas are written to `config.writer` as
// they arrive while the node still returns one complete AIMessage, so state
// reduction behaves exactly as it would under a plain `invoke()`. That is what
// lets the SSE route and the non-streaming path share one graph.

import {
  Annotation,
  StateGraph,
  END,
  START,
  messagesStateReducer,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  isAIMessage,
  isToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';

import { buildChatModel, type AgentLlm } from './model';
import { getTextSystemPrompt } from './prompts';
import { loadAccountSnapshot, renderSnapshot } from './context';
import {
  appendMessage,
  historyWindow,
  loadMessagesSince,
  loadRecentMessages,
  loadSummaryState,
  type LoadedMessage,
} from './persistence';
import { buildTools } from './tools';
import type { AgentToolEvent, PendingClientAction, ToolRuntime } from './types';

// ── State ───────────────────────────────────────────────────────────────────

export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  threadId: Annotation<string>(),
  userMessage: Annotation<string>(),
});

export type AgentState = typeof AgentStateAnnotation.State;

// ── Prompt assembly ─────────────────────────────────────────────────────────

/**
 * Build the message array for one turn.
 *
 * When the thread has a rolling summary we load history *since the summary
 * checkpoint* rather than the last N messages — otherwise there is a hole
 * between "what the summary covers" and "what the window replays". The
 * since-checkpoint read is capped at 3x the window so a lagging summariser
 * can't let the prompt grow without bound.
 */
async function buildTurnMessages(args: {
  userId: string;
  threadId: string;
  userMessage: string;
  currency: string;
  timezone: string;
  clientNow?: string;
}): Promise<BaseMessage[]> {
  const window = historyWindow();

  const [systemPrompt, snapshot, summaryState] = await Promise.all([
    getTextSystemPrompt(),
    loadAccountSnapshot({
      userId: args.userId,
      currency: args.currency,
      timezone: args.timezone,
      clientNow: args.clientNow,
    }),
    loadSummaryState(args.threadId),
  ]);

  const history: LoadedMessage[] = summaryState?.summaryThrough
    ? await loadMessagesSince(args.threadId, summaryState.summaryThrough, window * 3)
    : await loadRecentMessages(args.threadId, window);

  const summaryBlock = summaryState?.summary
    ? `\n\n## EARLIER IN THIS CONVERSATION\n${summaryState.summary}`
    : '';

  const system = `${systemPrompt}\n\n${renderSnapshot(snapshot, args.timezone)}${summaryBlock}`;

  return [
    new SystemMessage(system),
    ...history.map(toBaseMessage).filter((m): m is BaseMessage => m !== null),
    new HumanMessage(args.userMessage),
  ];
}

function toBaseMessage(m: LoadedMessage): BaseMessage | null {
  if (m.role === 'user') return new HumanMessage(m.content);
  if (m.role === 'assistant') return new AIMessage(m.content);
  return null; // tool rows are audit-only — see persistence.ts
}

// ── Graph ───────────────────────────────────────────────────────────────────

export interface BuildGraphOptions {
  runtime: ToolRuntime;
  /** Tests inject a stub so the graph runs without a real API key. */
  modelFactory?: () => AgentLlm;
}

export async function buildAgentGraph({ runtime, modelFactory }: BuildGraphOptions) {
  const model = (modelFactory ?? buildChatModel)();
  const tools = buildTools(runtime);
  // `bindTools` lives on the concrete chat models, not the BaseChatModel type.
  const boundModel = (model as unknown as { bindTools: (t: typeof tools) => AgentLlm }).bindTools(
    tools,
  );
  const toolNode = new ToolNode(tools);

  async function loadContextNode(state: AgentState): Promise<Partial<AgentState>> {
    const messages = await buildTurnMessages({
      userId: runtime.userId,
      threadId: state.threadId,
      userMessage: state.userMessage,
      currency: runtime.currency,
      timezone: runtime.timezone,
      clientNow: runtime.clientNow,
    });
    return { messages };
  }

  async function agentNode(
    state: AgentState,
    config?: LangGraphRunnableConfig,
  ): Promise<Partial<AgentState>> {
    let final: AIMessageChunk | undefined;
    const stream = await (
      boundModel as unknown as { stream: (m: BaseMessage[]) => Promise<AsyncIterable<AIMessageChunk>> }
    ).stream(state.messages);

    for await (const chunk of stream) {
      const delta = contentToText(chunk.content);
      // `config.writer` is absent when the graph runs via invoke() — guarded so
      // the same node serves both the streaming route and runTurn().
      if (delta) config?.writer?.({ type: 'token', delta });
      final = final ? final.concat(chunk) : chunk;
    }

    return { messages: [final ? new AIMessage(final) : new AIMessage('')] };
  }

  return new StateGraph(AgentStateAnnotation)
    .addNode('loadContext', loadContextNode)
    .addNode('agent', agentNode)
    .addNode('tools', toolNode)
    .addEdge(START, 'loadContext')
    .addEdge('loadContext', 'agent')
    .addConditionalEdges('agent', toolsCondition, ['tools', END])
    .addEdge('tools', 'agent')
    .compile();
}

// ── Message helpers ─────────────────────────────────────────────────────────

/**
 * Flatten message content to plain text.
 *
 * The Responses API returns content as an array of typed blocks rather than a
 * string. Persisting the raw array would poison the replayed history and the
 * rolling summary on later turns, so every write path goes through here.
 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object' && 'text' in block) {
        const text = (block as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('');
}

/** The last assistant message that isn't just a tool-call carrier. */
export function extractAssistantText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (isAIMessage(msg) && !msg.tool_calls?.length) return contentToText(msg.content);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAIMessage(messages[i])) return contentToText(messages[i].content);
  }
  return '';
}

export function extractToolEvents(messages: BaseMessage[]): AgentToolEvent[] {
  const argsById = new Map<string, unknown>();
  for (const msg of messages) {
    if (isAIMessage(msg) && msg.tool_calls?.length) {
      for (const call of msg.tool_calls) argsById.set(call.id ?? '', call.args);
    }
  }
  const events: AgentToolEvent[] = [];
  for (const msg of messages) {
    if (isToolMessage(msg)) {
      events.push({
        toolName: msg.name ?? 'unknown',
        args: argsById.get(msg.tool_call_id ?? '') ?? null,
        result: safeParse(msg.content),
      });
    }
  }
  return events;
}

function safeParse(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * Persist the turn: the user message, then every message produced after it
 * (tool results and the final assistant reply). History before the last
 * HumanMessage was already persisted on earlier turns.
 */
export async function persistTurn(
  threadId: string,
  userMessage: string,
  messages: BaseMessage[],
  actions: PendingClientAction[] = [],
): Promise<void> {
  await appendMessage(threadId, { role: 'user', content: userMessage });

  let lastHuman = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] instanceof HumanMessage) lastHuman = i;
  }

  // Collect before writing, so the turn's cards can ride on its *last*
  // assistant row. Replaying a transcript without them shows the agent saying
  // "the chart is on screen" above no chart.
  type Row = Parameters<typeof appendMessage>[1];
  const rows: Row[] = [];

  for (let i = lastHuman + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (isAIMessage(msg)) {
      const text = contentToText(msg.content);
      // Skip pure tool-call carriers: an empty assistant row replayed later
      // reads as the agent having said nothing, which confuses the model.
      if (text.trim().length === 0) continue;
      rows.push({ role: 'assistant', content: text });
    } else if (isToolMessage(msg)) {
      rows.push({
        role: 'tool',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        toolName: msg.name ?? undefined,
        toolPayload: safeParse(msg.content),
      });
    }
  }

  if (actions.length > 0) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === 'assistant') {
        rows[i] = { ...rows[i], actions };
        break;
      }
    }
  }

  for (const row of rows) {
    await appendMessage(threadId, row);
  }
}

// ── Non-streaming entry point ───────────────────────────────────────────────

export interface RunTurnArgs {
  runtime: ToolRuntime;
  userMessage: string;
  modelFactory?: () => AgentLlm;
}

export async function runTurn(args: RunTurnArgs): Promise<{
  assistantText: string;
  pendingClientActions: PendingClientAction[];
  toolEvents: AgentToolEvent[];
}> {
  const graph = await buildAgentGraph({ runtime: args.runtime, modelFactory: args.modelFactory });
  const result = (await graph.invoke({
    threadId: args.runtime.threadId,
    userMessage: args.userMessage,
    messages: [],
  })) as AgentState;

  await persistTurn(args.runtime.threadId, args.userMessage, result.messages, args.runtime.actions);

  return {
    assistantText: extractAssistantText(result.messages),
    pendingClientActions: args.runtime.actions,
    toolEvents: extractToolEvents(result.messages),
  };
}
