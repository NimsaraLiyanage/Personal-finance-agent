// GET /api/threads — the conversation list for the sidebar.

import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/session';
import { listThreads } from '@/lib/agent/persistence';

export const runtime = 'nodejs';

export async function GET() {
  const session = await resolveUser();
  const threads = await listThreads(session.userId);

  const response = NextResponse.json({
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title ?? t.messages[0]?.content?.slice(0, 60) ?? 'New conversation',
      updatedAt: t.updatedAt.toISOString(),
    })),
  });

  return response;
}
