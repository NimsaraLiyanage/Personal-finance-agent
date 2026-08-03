// POST /api/voice/session — start a voice session in either mode.
//
// The response shape is discriminated by `mode`, so the client branches once
// and the rest of its voice code is mode-specific by construction.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { resolveUser, SESSION_COOKIE } from '@/lib/session';
import { resolveOwnedThread } from '@/lib/agent/persistence';
import { getVoiceProvider, defaultVoiceMode } from '@/lib/voice';

export const runtime = 'nodejs';

const BodySchema = z.object({
  mode: z.enum(['realtime', 'pipeline']).optional(),
  threadId: z.string().optional().nullable(),
  timezone: z.string().optional(),
  clientNow: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const session = await resolveUser();
  const threadId = await resolveOwnedThread(session.userId, parsed.data.threadId);
  const provider = getVoiceProvider(parsed.data.mode ?? defaultVoiceMode());

  try {
    const voiceSession = await provider.createSession({
      userId: session.userId,
      threadId,
      currency: session.currency,
      timezone: parsed.data.timezone?.trim() || session.timezone,
      clientNow: parsed.data.clientNow,
    });

    const response = NextResponse.json(voiceSession);
    if (session.setCookie) {
      response.cookies.set(SESSION_COOKIE.name, session.setCookie, SESSION_COOKIE.options);
    }
    return response;
  } catch (err) {
    console.error('[voice] session mint failed:', err);
    return NextResponse.json(
      { error: (err as Error).message || 'Could not start a voice session' },
      { status: 502 },
    );
  }
}
