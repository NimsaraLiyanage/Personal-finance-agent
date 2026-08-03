// The voice provider abstraction.
//
// Two ways to give an agent a voice, with genuinely different shapes:
//
//   realtime — the client opens a direct duplex connection to a speech-native
//     model (WebRTC/WebSocket). The model hears raw audio, decides when the
//     user stopped talking, and speaks back. Lowest latency, best turn-taking,
//     billed per minute of audio.
//
//   pipeline — speech-to-text → the SAME text agent → text-to-speech. Higher
//     latency and cruder barge-in, but it reuses the entire LangGraph turn
//     (tools, memory, streaming) and costs a fraction.
//
// The interface below is the narrowest thing both fit through: "give me what
// the client needs to start talking". Everything provider-specific stays
// behind `mode`, and the client switches on that one field. Adding a third
// provider (Gemini Live, a self-hosted stack) means implementing this
// interface and registering it in index.ts — no route or UI change.

export type VoiceMode = 'realtime' | 'pipeline';

export interface VoiceSessionRequest {
  userId: string;
  threadId: string;
  currency: string;
  timezone: string;
  clientNow?: string;
}

interface VoiceSessionBase {
  mode: VoiceMode;
  sessionId: string;
  /** Unix seconds. 0 when the mode has no expiring credential. */
  expiresAt: number;
  threadId: string;
}

export interface RealtimeVoiceSession extends VoiceSessionBase {
  mode: 'realtime';
  /**
   * Ephemeral, short-lived client secret. This is the whole reason session
   * minting is a server route: the real API key must never reach a browser,
   * and this token is scoped to one session and expires in minutes.
   */
  clientSecret: string;
  model: string;
  /** SDP exchange endpoint for the browser's WebRTC offer. */
  callsUrl: string;
}

export interface PipelineVoiceSession extends VoiceSessionBase {
  mode: 'pipeline';
  /** Routes the client drives in sequence. */
  endpoints: {
    transcribe: string;
    chat: string;
    speak: string;
  };
  /** Client-side VAD tuning, so silence detection is configurable per deploy. */
  vad: {
    silenceMs: number;
    /** RMS below which a frame counts as silence, 0–1. */
    threshold: number;
  };
}

export type VoiceSession = RealtimeVoiceSession | PipelineVoiceSession;

export interface VoiceProvider {
  readonly mode: VoiceMode;
  createSession(request: VoiceSessionRequest): Promise<VoiceSession>;
}
