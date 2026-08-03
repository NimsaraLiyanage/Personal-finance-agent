// POST /api/voice/tool-call — execute a tool the realtime model asked for.
//
// In realtime mode the model runs on OpenAI's side and cannot reach our
// database, so it emits a function call, the browser relays it here, we
// execute it against the caller's own session, and the browser sends the
// output back into the audio session.
//
// The security property that makes this acceptable: the request body carries
// only a tool name and arguments. The user identity comes from the session
// cookie. A model that hallucinated someone else's user id would have nowhere
// to put it.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { resolveUser } from '@/lib/session';
import { resolveOwnedThread } from '@/lib/agent/persistence';
import { createToolRuntime } from '@/lib/agent/types';
import { executeVoiceTool } from '@/lib/voice/tools';

export const runtime = 'nodejs';

const BodySchema = z.object({
  toolName: z.string().min(1).max(64),
  args: z.unknown().optional(),
  threadId: z.string().optional().nullable(),
  timezone: z.string().optional(),
  clientNow: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const session = await resolveUser();
  const threadId = await resolveOwnedThread(session.userId, parsed.data.threadId);

  const toolRuntime = createToolRuntime({
    userId: session.userId,
    threadId,
    currency: session.currency,
    timezone: parsed.data.timezone?.trim() || session.timezone,
    clientNow: parsed.data.clientNow,
  });

  const result = await executeVoiceTool(
    toolRuntime,
    parsed.data.toolName,
    parsed.data.args ?? {},
  );

  return NextResponse.json({ output: result.output, actions: result.actions, threadId });
}
