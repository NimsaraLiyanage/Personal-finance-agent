// Thread + message persistence, and the rolling-summary read side.
//
// Two invariants worth stating because they are easy to break later:
//
// 1. Every read is scoped by `userId`, not just `threadId`. A thread id is a
//    cuid a client sends us — treating it as proof of ownership means anyone
//    who guesses one reads someone else's finances. `resolveOwnedThread` is
//    the only way to turn a client-supplied id into a usable thread.
//
// 2. `tool` rows are persisted but never replayed into the model. Their
//    ToolMessage form needs a tool_call_id linking back to an AIMessage we no
//    longer reconstruct, and the assistant's following text already absorbed
//    the result. They exist for audit and debugging.

import { prisma } from '../db';
import type { PendingClientAction } from './types';

export interface LoadedMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string | null;
  createdAt: Date;
}

export function historyWindow(): number {
  const raw = Number(process.env.AGENT_HISTORY_WINDOW);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100) : 20;
}

/**
 * Resolve a client-supplied thread id to one this user owns, or create a new
 * thread. An id belonging to someone else is treated as absent, not as an
 * error — a 403 here would confirm the thread exists.
 */
export async function resolveOwnedThread(userId: string, threadId?: string | null): Promise<string> {
  if (threadId) {
    const existing = await prisma.chatThread.findFirst({
      where: { id: threadId, userId },
      select: { id: true },
    });
    if (existing) return existing.id;
  }
  const created = await prisma.chatThread.create({ data: { userId } });
  return created.id;
}

export async function appendMessage(
  threadId: string,
  message: {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolName?: string;
    toolPayload?: unknown;
    /** Cards this turn produced. Only ever set on the turn's last assistant row. */
    actions?: PendingClientAction[];
  },
): Promise<void> {
  await prisma.chatMessage.create({
    data: {
      threadId,
      role: message.role,
      content: message.content,
      toolName: message.toolName ?? null,
      toolPayload: (message.toolPayload ?? undefined) as never,
      actions: (message.actions?.length ? message.actions : undefined) as never,
    },
  });
  await prisma.chatThread.update({
    where: { id: threadId },
    data: { updatedAt: new Date() },
  });
}

/** The last N user/assistant turns, oldest first. Tool rows excluded. */
export async function loadRecentMessages(threadId: string, limit: number): Promise<LoadedMessage[]> {
  const rows = await prisma.chatMessage.findMany({
    where: { threadId, role: { in: ['user', 'assistant'] } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { role: true, content: true, toolName: true, createdAt: true },
  });
  return rows.reverse() as LoadedMessage[];
}

/** Messages after the summary checkpoint, so summary + window = full history. */
export async function loadMessagesSince(
  threadId: string,
  since: Date,
  cap: number,
): Promise<LoadedMessage[]> {
  const rows = await prisma.chatMessage.findMany({
    where: { threadId, role: { in: ['user', 'assistant'] }, createdAt: { gt: since } },
    orderBy: { createdAt: 'asc' },
    take: cap,
    select: { role: true, content: true, toolName: true, createdAt: true },
  });
  return rows as LoadedMessage[];
}

export async function loadSummaryState(
  threadId: string,
): Promise<{ summary: string | null; summaryThrough: Date | null } | null> {
  return prisma.chatThread.findUnique({
    where: { id: threadId },
    select: { summary: true, summaryThrough: true },
  });
}

export async function saveSummaryState(
  threadId: string,
  summary: string,
  summaryThrough: Date,
): Promise<void> {
  await prisma.chatThread.update({
    where: { id: threadId },
    data: { summary, summaryThrough },
  });
}

export async function listThreads(userId: string, limit = 30) {
  return prisma.chatThread.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      messages: {
        where: { role: 'user' },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { content: true },
      },
    },
  });
}

export async function loadThreadMessages(userId: string, threadId: string) {
  const thread = await prisma.chatThread.findFirst({
    where: { id: threadId, userId },
    select: { id: true },
  });
  if (!thread) return null;
  return prisma.chatMessage.findMany({
    where: { threadId, role: { in: ['user', 'assistant'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, createdAt: true, actions: true },
  });
}

/** Remove a conversation. Scoped, so another user's id matches nothing. */
export async function deleteThread(userId: string, threadId: string): Promise<boolean> {
  // Messages go with it via the cascade on ChatMessage.threadId.
  const { count } = await prisma.chatThread.deleteMany({ where: { id: threadId, userId } });
  return count > 0;
}

/** Derive a thread title from its first user message, once. */
export async function ensureThreadTitle(threadId: string, firstUserMessage: string): Promise<void> {
  const thread = await prisma.chatThread.findUnique({
    where: { id: threadId },
    select: { title: true },
  });
  if (thread?.title) return;
  const title = firstUserMessage.trim().slice(0, 60) || 'New conversation';
  await prisma.chatThread.update({ where: { id: threadId }, data: { title } });
}
