// GET /api/threads/:id — replay one conversation.
// DELETE /api/threads/:id — drop it.

import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/session';
import { deleteThread, loadThreadMessages } from '@/lib/agent/persistence';
import type { PendingClientAction } from '@/lib/agent/types';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await resolveUser();

  const messages = await loadThreadMessages(session.userId, id);
  // A thread this user doesn't own is reported as missing, not forbidden —
  // a 403 would confirm the id exists.
  if (!messages) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    threadId: id,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      // Parked on the turn's last assistant row by persistTurn, so a replayed
      // transcript still renders the cards that were part of the answer.
      actions: (m.actions ?? []) as PendingClientAction[],
    })),
  });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await resolveUser();

  const removed = await deleteThread(session.userId, id);
  if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ ok: true });
}
