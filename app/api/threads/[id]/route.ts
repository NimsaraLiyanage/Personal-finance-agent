// GET /api/threads/:id — replay one conversation.

import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/session';
import { loadThreadMessages } from '@/lib/agent/persistence';

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
    })),
  });
}
