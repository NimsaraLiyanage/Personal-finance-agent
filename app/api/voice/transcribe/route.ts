// POST /api/voice/transcribe — pipeline mode, leg 1 of 3.
//
// Takes a recorded audio blob and returns text. Kept server-side rather than
// letting the browser call the STT provider directly, for the same reason as
// everything else here: the API key stays in this process.

import { NextResponse, type NextRequest } from 'next/server';

import { transcriptionModel } from '@/lib/voice/pipeline';
import { transcriptionBias } from '@/lib/voice/vocabulary';
import { readUser } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Above this, a "turn" is a recording session left running by accident. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY is not configured' }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const file = form.get('audio');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "audio" file field' }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: 'Audio too large' }, { status: 413 });
  }
  if (file.size === 0) {
    return NextResponse.json({ text: '' });
  }

  const upstream = new FormData();
  upstream.append('file', file, file.name || 'turn.webm');
  upstream.append('model', transcriptionModel());

  // A language hint cuts latency and misdetection on short utterances — but it
  // pins the transcriber to ONE language, which is wrong for a market where
  // "lunch එකට 450 ගියා" is an ordinary sentence. Leave it unset unless a
  // deployment is genuinely monolingual.
  const language = process.env.OPENAI_TRANSCRIBE_LANGUAGE?.trim();
  if (language) upstream.append('language', language);

  // Bias decoding toward the words this person actually uses. `readUser` never
  // creates a row: no session here just means a generic hint.
  const session = await readUser();
  upstream.append('prompt', await transcriptionBias(session?.userId ?? null));

  const base = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';

  try {
    const response = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('[voice] transcription failed:', response.status, detail.slice(0, 300));
      return NextResponse.json({ error: 'Transcription failed' }, { status: 502 });
    }

    const json = (await response.json()) as { text?: string };
    return NextResponse.json({ text: (json.text ?? '').trim() });
  } catch (err) {
    console.error('[voice] transcription error:', err);
    return NextResponse.json({ error: 'Transcription failed' }, { status: 502 });
  }
}
