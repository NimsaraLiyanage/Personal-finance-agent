// POST /api/voice/speak — pipeline mode, leg 3 of 3.
//
// Text in, audio out. The upstream response body is piped straight through
// rather than buffered, so the browser can start playing before synthesis has
// finished — which is most of what makes the pipeline mode feel tolerable.

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { speechModel, speechVoice } from '@/lib/voice/pipeline';

export const runtime = 'nodejs';
export const maxDuration = 60;

const BodySchema = z.object({
  text: z.string().min(1).max(4000),
  voice: z.string().max(40).optional(),
});

export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY is not configured' }, { status: 503 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const base = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';

  try {
    const response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: speechModel(),
        voice: parsed.data.voice || speechVoice(),
        input: parsed.data.text,
        // Opus in a WebM container streams and starts playing far sooner than
        // MP3, which browsers want largely buffered before decoding.
        response_format: 'opus',
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      console.error('[voice] speech failed:', response.status, detail.slice(0, 300));
      return NextResponse.json({ error: 'Speech synthesis failed' }, { status: 502 });
    }

    return new NextResponse(response.body, {
      headers: {
        'Content-Type': 'audio/ogg',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[voice] speech error:', err);
    return NextResponse.json({ error: 'Speech synthesis failed' }, { status: 502 });
  }
}
