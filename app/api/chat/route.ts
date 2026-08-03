// POST /api/chat — one turn, streamed as SSE.
//
// Both surfaces use this: the web chat streams from it directly, and the
// pipeline voice mode posts its transcript here too. That is the point of
// keeping voice out of the agent — there is exactly one turn implementation.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { resolveUser, SESSION_COOKIE } from '@/lib/session';
import { resolveOwnedThread } from '@/lib/agent/persistence';
import { createToolRuntime } from '@/lib/agent/types';
import { streamTurn, SSE_HEADERS } from '@/lib/agent/stream';

export const runtime = 'nodejs';
// The agent's turn can outlive a default serverless window on a multi-tool
// turn; the platform still caps this, but don't add our own shorter limit.
export const maxDuration = 120;

const BodySchema = z.object({
  message: z.string().min(1).max(4000),
  threadId: z.string().optional().nullable(),
  /** The browser's clock, so "yesterday" means the user's yesterday. */
  clientNow: z.string().optional(),
  timezone: z.string().optional(),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const session = await resolveUser();
  const threadId = await resolveOwnedThread(session.userId, parsed.data.threadId);

  const toolRuntime = createToolRuntime({
    userId: session.userId,
    threadId,
    currency: session.currency,
    // A timezone sent by the client wins: it reflects where the user actually
    // is, which the stored profile may not.
    timezone: parsed.data.timezone?.trim() || session.timezone,
    clientNow: parsed.data.clientNow,
  });

  const stream = streamTurn({ runtime: toolRuntime, userMessage: parsed.data.message });

  const response = new NextResponse(stream, { headers: SSE_HEADERS });
  if (session.setCookie) {
    response.cookies.set(SESSION_COOKIE.name, session.setCookie, SESSION_COOKIE.options);
  }
  return response;
}
