// Pipeline provider — speech-to-text → the text agent → text-to-speech.
//
// The cheap mode, and the one that shows the seams on purpose. There is no
// third-party voice session to mint: the client records a turn, posts the
// audio to /api/voice/transcribe, feeds the text to the ordinary /api/chat
// SSE endpoint, and posts the reply to /api/voice/speak.
//
// The payoff is that voice inherits the text agent wholesale — every tool,
// the rolling summary, the streamed cards — with no second implementation to
// keep in sync. The cost is turn-taking: barge-in has to be handled by the
// client stopping playback, and the gap between turns is the sum of three
// round trips instead of one duplex stream.

import type { PipelineVoiceSession, VoiceProvider, VoiceSessionRequest } from './types';
import { randomUUID } from 'node:crypto';

export function transcriptionModel(): string {
  return process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || 'gpt-transcribe';
}

export function speechModel(): string {
  return process.env.OPENAI_TTS_MODEL?.trim() || 'gpt-4o-mini-tts';
}

export function speechVoice(): string {
  return process.env.OPENAI_TTS_VOICE?.trim() || 'alloy';
}

function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export class PipelineVoiceProvider implements VoiceProvider {
  readonly mode = 'pipeline' as const;

  async createSession(request: VoiceSessionRequest): Promise<PipelineVoiceSession> {
    return {
      mode: 'pipeline',
      sessionId: randomUUID(),
      // Nothing expires — the client is authenticated by its session cookie on
      // every leg, so there is no bearer token to time out.
      expiresAt: 0,
      threadId: request.threadId,
      endpoints: {
        transcribe: '/api/voice/transcribe',
        chat: '/api/chat',
        speak: '/api/voice/speak',
      },
      vad: {
        silenceMs: num('PIPELINE_VAD_SILENCE_MS', 1200),
        threshold: Number(process.env.PIPELINE_VAD_THRESHOLD) || 0.015,
      },
    };
  }
}
