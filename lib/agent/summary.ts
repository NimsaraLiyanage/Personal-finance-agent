// Rolling conversation summary.
//
// The problem it solves: replaying the last N messages is fine for a short
// chat and useless for a long one — the agent forgets that you're saving for a
// trip, or that you already said you don't want dining alerts. Replaying
// *everything* instead grows the prompt (and the bill) without bound.
//
// So: once a thread exceeds a threshold, everything older than the live window
// is compressed into a paragraph, and the checkpoint is recorded. From then on
// the prompt is `summary + messages since checkpoint`, which stays roughly
// constant no matter how long the thread runs.
//
// This runs *after* the response is sent, never in the request path.

import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { prisma } from '../db';
import { buildChatModel, type AgentLlm } from './model';
import { contentToText } from './graph';
import { historyWindow, saveSummaryState } from './persistence';

const SUMMARY_PROMPT = `
You compress a conversation between a person and their personal finance
assistant into durable notes.

Keep only what changes how the assistant should behave in future turns:
- stated goals ("saving for a deposit by March", "trying to cut takeaway")
- standing preferences and boundaries ("don't nag me about coffee")
- recurring commitments mentioned in passing (rent day, subscriptions, payday)
- decisions already made, so they are not re-litigated

Drop: individual transaction amounts (those live in the database), pleasantries,
and anything the assistant already acted on and closed out.

Write 4-8 terse bullet points, no preamble, no heading. If an earlier summary is
supplied, merge it with the new messages and return ONE combined set of bullets —
do not append a second list.
`.trim();

/** Messages beyond this many trigger compression of everything older. */
function summaryThreshold(): number {
  const raw = Number(process.env.AGENT_SUMMARY_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

export async function maybeSummarizeThread(
  threadId: string,
  modelFactory?: () => AgentLlm,
): Promise<boolean> {
  const thread = await prisma.chatThread.findUnique({
    where: { id: threadId },
    select: { summary: true, summaryThrough: true },
  });
  if (!thread) return false;

  const where = {
    threadId,
    role: { in: ['user' as const, 'assistant' as const] },
    ...(thread.summaryThrough ? { createdAt: { gt: thread.summaryThrough } } : {}),
  };

  const uncompressed = await prisma.chatMessage.count({ where });
  if (uncompressed < summaryThreshold()) return false;

  const window = historyWindow();
  // Compress everything except the live window, so the messages the next turn
  // will replay verbatim are not also described in the summary.
  const toCompress = await prisma.chatMessage.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: uncompressed - window,
    select: { role: true, content: true, createdAt: true },
  });
  if (toCompress.length === 0) return false;

  const transcript = toCompress
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const input = thread.summary
    ? `EXISTING NOTES:\n${thread.summary}\n\nNEW MESSAGES:\n${transcript}`
    : `MESSAGES:\n${transcript}`;

  const model = (modelFactory ?? buildChatModel)();
  const response = await model.invoke([
    new SystemMessage(SUMMARY_PROMPT),
    new HumanMessage(input),
  ]);

  const summary = contentToText(response.content).trim();
  if (!summary) return false;

  await saveSummaryState(threadId, summary, toCompress[toCompress.length - 1].createdAt);
  return true;
}
